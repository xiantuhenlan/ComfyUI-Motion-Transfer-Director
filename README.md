# ComfyUI-Motion-Transfer-Director

闲兔动作迁移角色替换导演台。用时间线切分参考视频，为每个分镜绑定角色参考图和提示词，通过画布上的 MiniMax H3 工作流生成和预览结果。

## 安装与更新

- **ComfyUI Manager**：在 Registry 中搜索 `ComfyUI-Motion-Transfer-Director`（ID：`comfyui-motion-transfer-director`），安装或更新后重启 ComfyUI。也可打开 [Registry 页面](https://registry.comfy.org/nodes/comfyui-motion-transfer-director)。
- **GitHub**：在 `ComfyUI/custom_nodes` 下执行 `git clone https://github.com/xiantuhenlan/ComfyUI-Motion-Transfer-Director.git`，或从 [Releases](https://github.com/xiantuhenlan/ComfyUI-Motion-Transfer-Director/releases) 下载对应版本。Git 安装的副本在插件目录运行 `git pull --ff-only` 后重启 ComfyUI。
- 需要包含 MiniMax H3 官方节点的 ComfyUI。使用 ComfyUI 环境中的 PyTorch 和 PyAV。安装包不包含模型、LoRA、参考素材或工作流。

## 使用

1. 在画布搜索“闲兔动作迁移角色替换导演台”，连接 H3 的 CLIP、视频 VAE 和音频 VAE，再打开工作台。
2. 拖入参考视频和角色图，按时间线切分，给每镜填写提示词。一个分镜可添加多张角色参考图，按界面顺序对应提示词中的参考图编号。
3. 将 `positive` 和 `Latent` 接入画布下游。使用 H3 Add Guide 时，在节点选择 `guide`，将“引导视频帧”接到 H3 Add Guide；可用“分镜帧数”在合成前裁掉 H3 补帧。采样、解码和合成都由当前画布负责。
4. 可只生成当前分镜，也可勾选多个分镜按顺序生成。导演台显示进度并接收视频结果，已有结果可在双轨时间线对照播放。

资产库和硬件监控由可选的 `XiantuQwenImage21Director` 提供。本地素材上传与节点执行可独立使用。工作流如另接 KJNodes 的注意力优化节点，需安装对应插件及其运行依赖。提示词框直接使用用户填写的文本。

## 原声与输出命名

- 保留原声时，把“原声”输出接到下游视频合成节点的 `audio`。只输出画面时，合成节点的音频口留空。
- 将下游合成的 `VIDEO` 和导演台的“文件名”接到“闲兔动作导演台保存视频”。输出位于 `ComfyUI/output/H3角色替换动作迁移/`，例如第一镜的 `01-001.mp4`、`01-002.mp4`，第二镜的 `02-001.mp4`。可在导演台填写文件名前缀。
- 下方的声音和视频开关只影响预览。

版本记录见 [CHANGELOG.md](CHANGELOG.md)。项目维护者可用根目录的 `publish_action.example.yml` 配置 GitHub Actions，或使用 Comfy CLI 发布 Registry 新版本。
