"""Resource cleanup for the motion director's generation queue."""

import asyncio
import logging
import time

from aiohttp import web
from server import PromptServer


def unload_cached_models(model_management):
    """Unload idle entries without rereading a finalizer cleared by detach callbacks."""
    cache = model_management.current_loaded_models
    entries = tuple(cache)
    devices = model_management.get_all_torch_devices()
    # Hold both weakly referenced patchers and finalizers before any detach.
    # A detach callback may clear the cache entry's finalizer or remove it.
    patchers = [entry.model for entry in entries]
    finalizers = [entry.model_finalizer for entry in entries]
    for entry, patcher, finalizer in zip(entries, patchers, finalizers):
        if patcher is not None and entry.device not in devices:
            continue
        if patcher is not None:
            patcher.detach(True)
        if finalizer is not None:
            finalizer.detach()
        entry.model_finalizer = None
        entry.real_model = None
        for index, current in enumerate(cache):
            if current is entry:
                cache.pop(index)
                break


def with_idle_worker(operation, check=lambda: None):
    """Hold the queue mutex only after the worker has re-entered Condition.wait.

    task_done empties currently_running before worker-side flags/GC finish.
    A queue-only check therefore cannot protect current_loaded_models.
    The installed PromptQueue consumer waits on not_empty with the same mutex;
    observing its waiter while holding that mutex excludes its cleanup phase.
    """
    queue=getattr(getattr(PromptServer,"instance",None),"prompt_queue",None)
    if queue is None or not hasattr(queue,"mutex") or not hasattr(queue, "not_empty"):
        return False
    deadline = time.monotonic()+60
    while True:
        check()
        with queue.mutex:
            if queue.currently_running or queue.queue:
                return False
            if getattr(queue.not_empty, "_waiters", ()):
                operation(queue)
                return True
        if time.monotonic() >= deadline:
            raise RuntimeError("等待生成线程完成收尾清理超时；生成线程可能已经退出，请重启 ComfyUI 后再运行")
        time.sleep(0.02)


def cleanup_idle_resources(settings, check=lambda: None):
    cache_requested = bool(settings.get("cache"))
    def cleanup(queue):
        import comfy.model_management
        if settings.get("models"):
            unload_cached_models(comfy.model_management)
        if settings.get("vram") or settings.get("models"):
            comfy.model_management.soft_empty_cache()
        if cache_requested:
            # Clear execution caches on their owner thread. Do not request a
            # second core model unload after our completed model cleanup.
            if "unload_models" not in queue.flags:
                queue.set_flag("unload_models", False)
            queue.set_flag("free_memory", True)
    if not with_idle_worker(cleanup, check):
        return {"warnings":["生成队列仍有任务或无法确认线程空闲，本次跳过资源清理"]}
    if cache_requested and not with_idle_worker(lambda queue: None, check):
        return {"warnings":["缓存清理已交给生成线程，等待当前队列完成"]}
    return {"warnings":[]}


class CleanupCancelled(Exception):
    pass


def register_cleanup_routes():
    @PromptServer.instance.routes.post("/xiantu/motion-director/cleanup")
    async def cleanup(request):
        try:
            settings = await request.json()
        except ValueError:
            return web.json_response({"ok": False, "error": "资源清理参数必须是 JSON 对象"}, status=400)
        if not isinstance(settings, dict):
            return web.json_response({"ok": False, "error": "资源清理参数必须是 JSON 对象"}, status=400)

        def check_connection():
            if request.transport is None or request.transport.is_closing():
                raise CleanupCancelled("资源清理已取消")

        try:
            result = await asyncio.to_thread(cleanup_idle_resources, settings, check_connection)
            return web.json_response({"ok": True, **result})
        except CleanupCancelled as error:
            return web.json_response({"ok": False, "cancelled": True, "error": str(error)}, status=409)
        except Exception as error:
            logging.exception("[MotionTransferDirector] Resource cleanup failed")
            return web.json_response({"ok": False, "error": str(error)}, status=500)
