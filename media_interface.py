"""Current-shot reference conditioning; all sampling remains downstream."""
import json
import math
import torch
import nodes
import folder_paths
from comfy_api.latest import io, InputImpl
from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo
from .reference_video import read_reference_video, read_original_reference
from .execution_progress import ExecutionProgress, ProgressProxy
from .video_output import next_output_name


class ComfyUIMotionTransferDirector(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ComfyUIMotionTransferDirector",
            display_name="闲兔动作迁移角色替换导演台",
            category="闲兔/动作迁移",
            inputs=[io.Clip.Input("clip"), io.Vae.Input("vae"),
                    io.Vae.Input("audio_vae"),
                    io.String.Input("shot_json", default="{}", multiline=True),
                    io.Combo.Input("conditioning_mode", options=["video_audio", "guide", "pose"],
                                   default="video_audio", optional=True,
                                   display_name="参考条件",
                                   tooltip="video_audio：视频与音频参考。guide：仅角色条件，视频接 Add Guide。pose：角色和视频条件，视频同时接姿态预处理。")],
            outputs=[io.Conditioning.Output(display_name="positive"), io.Latent.Output(),
                     io.Audio.Output(display_name="原声"),
                     io.Image.Output(display_name="引导视频帧", tooltip="guide 和 pose 模式输出对齐至 24 fps 并补齐的源视频帧。"),
                     io.Int.Output(display_name="分镜帧数", tooltip="24 fps 下的实际分镜帧数，用于导出前裁掉补帧。"),
                     io.String.Output(display_name="文件名", tooltip="连接到闲兔动作导演台保存视频节点，按分镜独立递增版本。")],
        )

    @classmethod
    def execute(cls, clip, vae, audio_vae, shot_json, conditioning_mode="video_audio"):
        shot = json.loads(shot_json)
        if not str(shot.get("prompt") or "").strip():
            raise ValueError("请先填写当前分镜提示词，不能为空或只有空格。")
        filename = next_output_name(shot)
        progress = ExecutionProgress(shot)
        progress("检查分镜素材")
        if not shot.get("video") or not shot.get("character"):
            raise ValueError("请在导演台选择源视频、角色图并应用当前分镜。")
        start, end = float(shot["inPoint"]), float(shot["outPoint"])
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise ValueError("分镜入点／出点无效。")
        width, height = int(shot.get("generationWidth", 640)), int(shot.get("generationHeight", 832))
        if width < 32 or height < 32 or width % 32 or height % 32:
            raise ValueError("生成宽高须为不小于 32 的 32 倍数。")
        count = round((end - start) * 24)
        padded = 5 + 17 * max(0, math.ceil((count - 5) / 17))
        if count < 5 or padded > 3600:
            raise ValueError("当前分镜帧数须在 H3 支持的 5～3600 帧内；请拆分过长分镜。")
        video = InputImpl.VideoFromFile(folder_paths.get_annotated_filepath(shot["video"]))
        if end > video.get_duration() + 1e-6:
            raise ValueError("分镜范围超出源视频。")
        selected = video.as_trimmed(start_time=start, duration=end-start, strict_duration=True)
        if selected is None:
            raise ValueError("无法读取当前分镜视频范围。")
        reference_mode = shot.get("referenceVideoMode", "original")
        if reference_mode == "original":
            progress("参考视频／音频解码中", f"原尺寸 · {start:.2f}～{end:.2f} 秒")
            components = read_original_reference(folder_paths.get_annotated_filepath(shot["video"]), start, end, progress=progress)
        else:
            limit_width, limit_height = ((width, height) if reference_mode == "generation" else
                                        (int(shot.get("referenceVideoWidth", 640)),
                                         int(shot.get("referenceVideoHeight", 384))))
            progress("参考视频解码／缩放中", f"尺寸上限 {limit_width}×{limit_height}")
            components = read_reference_video(
                folder_paths.get_annotated_filepath(shot["video"]), start, end,
                max(32, limit_width), max(32, limit_height),
                progress=progress,
            )
        source, rate = components.images, float(components.frame_rate)
        if not math.isfinite(rate) or rate <= 0 or source.shape[0] == 0:
            raise ValueError("视频没有有效帧或帧率。")
        progress("分镜帧率对齐中", f"已解码 {source.shape[0]} 帧 · 对齐 24fps／{padded} 帧")
        indices = torch.floor(torch.arange(count, dtype=torch.float64) / 24 * rate).long()
        frames = source[indices.clamp(0, source.shape[0]-1)].clone()
        if padded > count:
            frames = torch.cat((frames, frames[-1:].repeat(padded-count, 1, 1, 1)), dim=0)
        progress("读取角色参考图")
        character_paths = [shot["character"], *(shot.get("additionalCharacters") or [])]
        characters = {f"ref_image_{index}": nodes.LoadImage().load_image(path)[0][:1]
                      for index, path in enumerate(character_paths)}
        source_audio = None
        if components.audio is not None:
            sample_rate = components.audio["sample_rate"]
            source_audio = {"sample_rate": sample_rate,
                            "waveform": components.audio["waveform"][..., :int((end-start)*sample_rate)].clone()}
        audio = None
        if conditioning_mode == "video_audio" and components.audio is not None:
            sample_rate = components.audio["sample_rate"]
            audio = {"sample_rate": sample_rate,
                     "waveform": components.audio["waveform"][..., :round(count / 24 * sample_rate)].clone()}
        progress("准备参考条件编码")
        encoded = MiniMaxH3ReferenceToVideo.execute(
            clip=ProgressProxy(clip, progress, {"tokenize": ["提示词与参考素材解析中"],
                                              "encode_from_tokens_scheduled": ["提示词／参考条件编码中"]}),
            vae=ProgressProxy(vae, progress, {"encode": ["角色参考图 VAE 编码中", "参考视频 VAE 编码中"]}),
            audio_vae=ProgressProxy(audio_vae, progress, {"encode": ["参考音频 VAE 编码中"]}),
            prompt=shot.get("prompt", ""), width=width, height=height,
            length=padded, ref_image_size=shot.get("refImageSize", "max"),
            ref_images=characters,
            ref_videos={"ref_video_0": frames} if conditioning_mode != "guide" else {},
            ref_video_audios={"ref_video_audio_0": audio} if audio is not None else {},
        )
        progress("参考条件已就绪", "等待后续采样节点")
        guide_frames = frames if conditioning_mode in {"guide", "pose"} else None
        return io.NodeOutput(*encoded.result, source_audio, guide_frames, count, filename)
