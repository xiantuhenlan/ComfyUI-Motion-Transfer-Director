"""Director media interface; leaves the connected workflow unchanged."""
from comfy_api.latest import ComfyExtension
from .media_interface import ComfyUIMotionTransferDirector
from .cleanup_routes import register_cleanup_routes
from .video_output import XiantuMotionDirectorSaveVideo

register_cleanup_routes()

__version__ = "0.1.1"
WEB_DIRECTORY = "./web"


class MotionTransferDirectorExtension(ComfyExtension):
    async def get_node_list(self):
        return [ComfyUIMotionTransferDirector, XiantuMotionDirectorSaveVideo]


async def comfy_entrypoint():
    return MotionTransferDirectorExtension()
