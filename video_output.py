"""Versioned MP4 output for motion director shots."""
import re
import tempfile
from pathlib import Path, PurePosixPath
from threading import Lock

import folder_paths
from comfy.cli_args import args
from comfy_api.latest import Types, io, ui


OUTPUT_FOLDER = "H3角色替换动作迁移"
_VERSIONED_NAME = re.compile(r"(?P<prefix>.*?)(?P<shot>[0-9]{2,})-(?P<version>[0-9]{3,})\.mp4", re.IGNORECASE)
_INVALID_PREFIX = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_save_lock = Lock()


def _output_directory():
    return Path(folder_paths.get_output_directory()) / OUTPUT_FOLDER


def _next_version(directory, shot_index):
    latest = 0
    if directory.is_dir():
        for entry in directory.iterdir():
            match = _VERSIONED_NAME.fullmatch(entry.name)
            if match and int(match["shot"]) == shot_index and entry.is_file():
                latest = max(latest, int(match["version"]))
    return latest + 1


def _filename(prefix, shot_index, version):
    return f"{prefix}{shot_index:02d}-{version:03d}.mp4"


def next_output_name(shot):
    prefix = str(shot.get("filenamePrefix") or "").strip()
    if len(prefix) > 100 or _INVALID_PREFIX.search(prefix):
        raise ValueError("保存文件名最多 100 字，且不能包含文件路径或 Windows 文件名禁用字符。")
    if prefix and prefix[-1] in "0123456789":
        prefix += "-"
    shot_index = shot.get("shotIndex")
    if not isinstance(shot_index, int) or shot_index < 1:
        shots = (shot.get("projectState") or {}).get("shots", [])
        shot_index = next((i for i, item in enumerate(shots, 1) if item.get("id") == shot.get("id")), None)
        if shot_index is None:
            match = re.fullmatch(r"分镜\s*([0-9]+)", str(shot.get("name") or ""))
            shot_index = max(1, int(match[1])) if match else 1
    version = _next_version(_output_directory(), shot_index)
    return f"{OUTPUT_FOLDER}/{_filename(prefix, shot_index, version)}"


class XiantuMotionDirectorSaveVideo(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="XiantuMotionDirectorSaveVideo",
            display_name="闲兔动作导演台保存视频",
            category="闲兔/动作迁移",
            inputs=[io.Video.Input("video"), io.String.Input("filename", force_input=True, display_name="文件名")],
            outputs=[io.Video.Output("video")],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
            not_idempotent=True,
        )

    @classmethod
    def execute(cls, video, filename):
        path = PurePosixPath(filename)
        match = _VERSIONED_NAME.fullmatch(path.name)
        if path.parent != PurePosixPath(OUTPUT_FOLDER) or not match or _INVALID_PREFIX.search(match["prefix"]):
            raise ValueError("请连接动作导演台的文件名输出。")

        directory = _output_directory()
        directory.mkdir(parents=True, exist_ok=True)
        shot_index = int(match["shot"])
        metadata = None
        if not args.disable_metadata:
            metadata = dict(cls.hidden.extra_pnginfo or {})
            if cls.hidden.prompt is not None:
                metadata["prompt"] = cls.hidden.prompt

        with tempfile.NamedTemporaryFile(dir=directory, prefix=".xiantu-", suffix=".mp4", delete=False) as handle:
            temporary = Path(handle.name)
        try:
            video.save_to(str(temporary), format=Types.VideoContainer("mp4"),
                          codec=Types.VideoCodec("auto"), metadata=metadata or None)
            with _save_lock:
                version = _next_version(directory, shot_index)
                while True:
                    target = directory / _filename(match["prefix"], shot_index, version)
                    try:
                        target.touch(exist_ok=False)
                    except FileExistsError:
                        version += 1
                        continue
                    try:
                        temporary.replace(target)
                    except OSError:
                        target.unlink(missing_ok=True)
                        raise
                    break
        finally:
            temporary.unlink(missing_ok=True)

        return io.NodeOutput(video, ui=ui.PreviewVideo([ui.SavedResult(target.name, OUTPUT_FOLDER, io.FolderType.output)]))
