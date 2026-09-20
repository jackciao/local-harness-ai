# local-harness-ai

面向本地 GGUF 模型的 Mac 桌面运行器：启动 `llama.cpp` 服务，提供对话、开发代理、模型状态和视觉图片输入。

## 功能

- 本地 OpenAI 兼容 API 服务与聊天界面
- 支持与主模型匹配的 MMProj 视觉投影，发送图片进行识图
- 内置开发代理，可在指定工作区读取和编辑代码
- 可配置上下文、GPU offload、KV cache 和推理参数

## 下载

从 [Releases](https://github.com/jackciao/local-harness-ai/releases) 下载：

- macOS arm64：`local_harness_ai_1_0.dmg`，将应用拖至 `Applications` 后启动

发布包不包含模型。请自行准备 `.gguf` 主模型；使用视觉功能时，还需选择该模型对应的 `mmproj` `.gguf` 文件。

## 源码

依赖以 Git 子模块管理，克隆时请带上：

```bash
git clone --recurse-submodules https://github.com/jackciao/local-harness-ai.git
```
