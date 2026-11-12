"""Task-scoped status reporting without changing conditioning or sampling."""
import logging
import time


class ExecutionProgress:
    def __init__(self, shot):
        from comfy_execution.utils import get_executing_context
        self.context = get_executing_context()
        self.token = shot.get("runToken")
        self.last_decode = 0.0

    @staticmethod
    def check():
        from comfy.model_management import throw_exception_if_processing_interrupted
        throw_exception_if_processing_interrupted()

    def __call__(self, phase, detail="", value=0, max=0):
        self.check()
        if self.context is None:
            return
        from server import PromptServer
        try:
            PromptServer.instance.send_sync("xiantu_motion_progress", {
                "prompt_id": self.context.prompt_id, "node": self.context.node_id,
                "runToken": self.token, "phase": phase, "detail": detail,
                "value": value, "max": max,
            })
        except Exception:
            logging.debug("Motion director status delivery failed", exc_info=True)

    def decoded(self, count, width, height):
        self.check()
        now = time.monotonic()
        if count == 1 or now - self.last_decode >= 0.3:
            self.last_decode = now
            self("参考视频解码／缩放中", f"已处理 {count} 帧 · {width}×{height}")


class ProgressProxy:
    """Delegate the original objects; only wrap the named method calls."""
    def __init__(self, target, progress, methods):
        self._target, self._progress, self._methods = target, progress, methods
        self._calls = {}

    def __getattr__(self, name):
        original = getattr(self._target, name)
        labels = self._methods.get(name)
        if labels is None:
            return original

        def measured(*args, **kwargs):
            index = self._calls.get(name, 0)
            self._calls[name] = index + 1
            label = labels[min(index, len(labels) - 1)]
            self._progress(label)
            result = original(*args, **kwargs)
            self._progress.check()
            return result
        return measured
