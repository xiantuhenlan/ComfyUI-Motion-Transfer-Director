"""Current-shot interfaces. Sampling stays in the official external nodes.

No FeiHou/SelfLift imports, continuation cache, colour matching or prompt edits.
The two passes use the connected sigma schedule split at first_steps; this is
an explicit basic two-pass chain, not FeiHou's dual-clock/refinement recipe.
"""
import json
import math
from dataclasses import dataclass

import torch
import nodes
import folder_paths
from comfy_api.latest import io, InputImpl
from comfy_extras import nodes_minimax_h3 as h3
from comfy_extras.nodes_custom_sampler import BasicGuider

ContextPort = io.Custom("XIANTU_MOTION_CONTEXT")


def result(value, index=0):
    return value.result[index]


@dataclass(frozen=True)
class ShotContext:
    model: object
    clip: object
    vae: object
    audio_vae: object
    noise: object
    sampler: object
    remaining_sigmas: object
    prompt: str
    character: object
    reference_frames: object
    reference_audio: object
    source_audio: object
    frames: int
    padded_frames: int
    width: int
    height: int
    shot_id: str


def audio_slice(audio, start, end):
    if audio is None:
        return None
    rate = int(audio["sample_rate"])
    return {"sample_rate": rate,
            "waveform": audio["waveform"][..., round(start * rate):round(end * rate)].clone()}


def read_shot(payload):
    shot = json.loads(payload)
    prompt = shot.get("prompt")
    if not isinstance(prompt, str):
        raise ValueError("请在导演台应用当前分镜，提示词必须是文本。")
    start, end = float(shot["inPoint"]), float(shot["outPoint"])
    if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
        raise ValueError("分镜入点／出点无效。")
    # ComfyUI input annotations resolve the built-in local upload paths.
    video = InputImpl.VideoFromFile(folder_paths.get_annotated_filepath(shot["video"]))
    if end > video.get_duration() + 1e-6:
        raise ValueError("分镜范围超出实际源视频。")
    selected = video.as_trimmed(start_time=start, duration=end - start, strict_duration=True)
    if selected is None:
        raise ValueError("无法读取指定分镜范围。")
    components = selected.get_components()
    rate = float(components.frame_rate)
    source = components.images
    if rate <= 0 or end - start > source.shape[0] / rate + 1 / rate:
        raise ValueError("分镜范围超出实际源视频。")
    count = round((end - start) * 24)
    if count < 5:
        raise ValueError("H3 当前分镜至少需要 5 帧。")
    indices = torch.floor(torch.arange(count, dtype=torch.float64) / 24 * rate).long()
    frames = source[indices.clamp(0, source.shape[0] - 1)].clone()
    padded = 5 + 17 * max(0, math.ceil((count - 5) / 17))
    if padded > count:
        frames = torch.cat((frames, frames[-1:].repeat(padded - count, 1, 1, 1)), dim=0)
    character = nodes.LoadImage().load_image(shot["character"])[0][:1]
    audio = audio_slice(components.audio, 0, count / 24)
    return shot, prompt, frames, character, audio, count, padded


def conditioning(context, width, height):
    encoded = h3.MiniMaxH3ReferenceToVideo.execute(
        clip=context.clip, vae=context.vae, audio_vae=context.audio_vae,
        prompt=context.prompt, width=width, height=height,
        length=context.padded_frames, ref_image_size="match",
        ref_images={"ref_image_0": context.character},
        ref_videos={"ref_video_0": context.reference_frames},
        ref_video_audios=({"ref_video_audio_0": context.reference_audio}
                          if context.reference_audio is not None else {}),
    )
    return result(encoded), result(encoded, 1)


class ComfyUIMotionTransferDirector(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ComfyUIMotionTransferDirector",
            display_name="闲兔动作迁移角色替换导演台", category="闲兔/动作迁移",
            description="应用当前分镜后准备官方一采输入。不执行采样，不自动续接或调色。",
            inputs=[io.Model.Input("model"), io.Clip.Input("clip"), io.Vae.Input("vae"),
                    io.Vae.Input("audio_vae"), io.Noise.Input("noise"),
                    io.Sampler.Input("sampler"), io.Sigmas.Input("sigmas"),
                    io.Int.Input("first_steps", default=5, min=1, max=10000),
                    io.Int.Input("width", default=1344, min=32, max=nodes.MAX_RESOLUTION, step=32),
                    io.Int.Input("height", default=768, min=32, max=nodes.MAX_RESOLUTION, step=32),
                    io.Boolean.Input("reference_soundtrack", default=True),
                    io.String.Input("shot_json", default="{}", multiline=True)],
            outputs=[io.Noise.Output(display_name="noise"), io.Guider.Output(display_name="guider"),
                     io.Sampler.Output(display_name="sampler"), io.Sigmas.Output(display_name="sigmas"),
                     io.Latent.Output(display_name="latent"), ContextPort.Output(display_name="context")],
        )

    @classmethod
    def execute(cls, model, clip, vae, audio_vae, noise, sampler, sigmas,
                first_steps, width, height, reference_soundtrack, shot_json):
        if not 0 < first_steps < len(sigmas) - 1:
            raise ValueError("一采步数必须小于连接的 SIGMAS 总步数，给二采保留至少一步。")
        if width % 32 or height % 32:
            raise ValueError("H3 宽高须为 32 的倍数。")
        shot, prompt, frames, character, audio, count, padded = read_shot(shot_json)
        context = ShotContext(model, clip, vae, audio_vae, noise, sampler,
                              sigmas[first_steps:].clone(), prompt, character, frames,
                              audio if reference_soundtrack else None, audio,
                              count, padded, width, height, str(shot["id"]))
        positive, latent = conditioning(context, width, height)
        guider = result(BasicGuider.execute(model, positive))
        return io.NodeOutput(noise, guider, sampler, sigmas[:first_steps + 1].clone(), latent, context)


class MotionSecondPass(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="XiantuMotionSecondPass", display_name="闲兔动作迁移｜二采准备",
                         category="闲兔/动作迁移", inputs=[ContextPort.Input("context"),
                         io.Latent.Input("denoised_output"), io.LatentUpscaleModel.Input("upscale_model"),
                         io.Float.Input("upscale_by", default=1.5, min=1.0, max=4.0, step=0.05)],
                         outputs=[io.Noise.Output(display_name="noise"), io.Guider.Output(display_name="guider"),
                                  io.Sampler.Output(display_name="sampler"), io.Sigmas.Output(display_name="sigmas"),
                                  io.Latent.Output(display_name="latent")])

    @classmethod
    def execute(cls, context, denoised_output, upscale_model, upscale_by):
        width = max(32, round(context.width * upscale_by / 32) * 32)
        height = max(32, round(context.height * upscale_by / 32) * 32)
        latent = result(h3.MiniMaxH3LatentUpscaleWithModel.execute(upscale_model, denoised_output, width, height))
        positive, _unused = conditioning(context, width, height)
        guider = result(BasicGuider.execute(context.model, positive))
        return io.NodeOutput(context.noise, guider, context.sampler, context.remaining_sigmas.clone(), latent)


class MotionCollect(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="XiantuMotionCollect", display_name="闲兔动作迁移｜结果收集",
                         category="闲兔/动作迁移", inputs=[io.Latent.Input("samples"),
                         ContextPort.Input("context"), io.Boolean.Input("keep_source_audio", default=True)],
                         outputs=[io.Image.Output(display_name="images"), io.Audio.Output(display_name="audio"),
                                  io.Float.Output(display_name="fps")])

    @classmethod
    def execute(cls, samples, context, keep_source_audio):
        images = nodes.VAEDecode().decode(context.vae, samples)[0]
        if images.shape[0] < context.frames:
            raise ValueError("解码帧数不足，不能假装已生成完整分镜。")
        images = images[:context.frames]
        if keep_source_audio:
            audio = context.source_audio
        else:
            from comfy_extras.nodes_audio import VAEDecodeAudio
            audio = audio_slice(result(VAEDecodeAudio.execute(context.audio_vae, samples)), 0, context.frames / 24)
        return io.NodeOutput(images, audio, 24.0)
