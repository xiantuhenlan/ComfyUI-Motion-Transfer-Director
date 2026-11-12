"""Independent, bounded reference-video decoding. No custom-node imports."""
from fractions import Fraction
from types import SimpleNamespace
import math

import av
import numpy as np
import torch


def window_pts(start, end, time_base):
    """First timestamp at/after start; exclusive end at/after end."""
    def ceil_tick(value):
        tick = Fraction(str(value)) / time_base
        nearest = round(tick)
        return nearest if abs(float(tick-nearest)) < 1e-9 else math.ceil(tick)
    return ceil_tick(start), ceil_tick(end)


def read_original_reference(path, start, end, progress=None):
    """Retain core pixel conversion while correcting its floored trim ticks."""
    from comfy_api.latest import InputImpl
    timestamps = []
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        base = Fraction(stream.time_base)
        first, last = window_pts(start, end, base)
        floor_start = int(start / base)
        duration = float(last * base) - start
        while int((start + duration) / base) < last:
            duration = math.nextafter(duration, math.inf)
        core_end = int((start + duration) / base)
        if floor_start:
            container.seek(floor_start, stream=stream)
        for frame in container.decode(stream):
            if progress is not None:
                progress.check()
            if frame.pts < floor_start:
                continue
            if frame.pts >= core_end:
                break
            timestamps.append(frame.pts)
    selected = InputImpl.VideoFromFile(str(path)).as_trimmed(start_time=start, duration=duration, strict_duration=False)
    components = selected.get_components()
    if len(timestamps) != components.images.shape[0]:
        raise ValueError("视频帧时间与解码结果不一致，无法读取准确分镜范围。")
    kept = [i for i, pts in enumerate(timestamps) if first <= pts < last]
    if not kept:
        raise ValueError("当前分镜范围没有可读取的画面。")
    images = components.images[kept[0]:kept[-1]+1]
    audio = components.audio
    if audio is not None:
        audio = {"sample_rate": audio["sample_rate"],
                 "waveform": audio["waveform"][..., :int((end-start)*audio["sample_rate"])]}
    return SimpleNamespace(images=images, audio=audio, frame_rate=components.frame_rate)


def reference_size(source_width, source_height, max_width, max_height):
    """Fit the source inside a 32px-aligned envelope without cropping it."""
    scale = min(1.0, max_width / source_width, max_height / source_height)
    return (max(32, int(source_width * scale) // 32 * 32),
            max(32, int(source_height * scale) // 32 * 32))


def read_reference_video(path, start, end, max_width, max_height, progress=None):
    """Match the existing source-frame selection; resize BEFORE retaining RGB.

    Output keeps source FPS so the caller retains its existing 24fps sampling.
    Only the requested interval is retained. Audio is decoded independently of
    image sizing and kept at its original sample rate and channel count.
    """
    frames, audio_frames = [], []
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        rate = Fraction(stream.average_rate) if stream.average_rate else Fraction(1)
        start_pts, end_pts = window_pts(start, end, stream.time_base)
        seek_pts = int(start / stream.time_base)
        if seek_pts:
            container.seek(seek_pts, stream=stream)
        audio_stream = container.streams.audio[-1] if container.streams.audio else None
        streams = [stream] + ([audio_stream] if audio_stream is not None else [])
        resampler = av.AudioResampler(format="fltp") if audio_stream is not None else None
        video_done, audio_done, audio_started = False, audio_stream is None, False
        for packet in container.demux(*streams):
            if progress is not None:
                progress.check()
            if video_done and audio_done:
                break
            if packet.stream.type == "video":
                if video_done:
                    continue
                for frame in packet.decode():
                    if progress is not None:
                        progress.check()
                    if frame.pts is not None and frame.pts < start_pts:
                        continue
                    if frame.pts is not None and frame.pts >= end_pts:
                        video_done = True
                        break
                    rotation = int(round(float(getattr(frame, "rotation", 0)) / 90)) % 4
                    sw, sh = (frame.height, frame.width) if rotation % 2 else (frame.width, frame.height)
                    width, height = reference_size(sw, sh, max_width, max_height)
                    # swscale receives the target dimensions, never a full-size
                    # RGB tensor. Compressed source files are never rewritten.
                    rw, rh = (height, width) if rotation % 2 else (width, height)
                    pixels = frame.reformat(width=rw, height=rh, format="gbrpf32le").to_ndarray()
                    if rotation:
                        pixels = np.rot90(pixels, k=rotation)
                    frames.append(np.ascontiguousarray(pixels))
                    if progress is not None:
                        progress.decoded(len(frames), width, height)
            elif packet.stream.type == "audio" and not audio_done:
                for raw in packet.decode():
                    for frame in resampler.resample(raw):
                        timestamp = frame.time
                        if timestamp is not None and timestamp > end:
                            audio_done = True
                            break
                        data = frame.to_ndarray()
                        if not audio_started:
                            offset = start - float(frame.pts * audio_stream.time_base)
                            skip = max(0, int(offset * audio_stream.sample_rate))
                            if skip >= frame.samples:
                                continue
                            data = data[..., skip:]
                            audio_started = True
                        audio_frames.append(data)
        if not frames:
            raise ValueError("当前参考视频范围没有可读取的画面。")
        if progress is not None:
            progress("整理参考视频／音频", f"已解码并缩放 {len(frames)} 帧 · {width}×{height}")
        images = torch.from_numpy(np.stack(frames))
        audio = None
        if audio_frames:
            waveform = np.concatenate(audio_frames, axis=1)
            sample_rate = int(audio_stream.sample_rate)
            waveform = waveform[..., :int((end - start) * sample_rate)]
            audio = {"sample_rate": sample_rate, "waveform": torch.from_numpy(waveform).unsqueeze(0)}
    return SimpleNamespace(images=images, audio=audio, frame_rate=rate)
