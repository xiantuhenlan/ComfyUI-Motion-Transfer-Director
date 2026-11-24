"""Resource cleanup for the motion director's generation queue."""
import asyncio
import logging
from aiohttp import web
from server import PromptServer
from .resource_cleanup import cleanup_idle_resources as _cleanup_idle_resources


def cleanup_idle_resources(settings, check=lambda: None):
    return _cleanup_idle_resources(PromptServer.instance, settings, check)


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
