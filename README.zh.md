# awesome-mooling-dsh-plugins

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

我自己开发和常用的 dsh 插件。没有链接的条目表示该插件仍只在本地开发。

[English](README.md)

## 插件元数据

这里的插件元数据指的是分布在此仓库源码目录 plugins/ 下的各个插件的数据。由于大部分插件都是以 `dsh-xx` 开头，因此使用前六位字符作为前置索引目录。对于不是以这个前缀开头的插件，应该使用前两位字符作为前置索引目录。

插件元数据存储结构参考了 [nixpkgs](https://github.com/NixOS/nixpkgs/tree/master/pkgs/by-name) 和 [nix-packages](https://github.com/Mooling0602/nix-packages/tree/main/pkgs/by-name)。

更具体的解析规则和内容设计，请查看[文档](DOCS.zh.md)。

## dsh-mloader-plugins

这些是 [dsh-mloader](https://github.com/Mooling0602/dsh-mloader) 所支持的独立于 DSH 的插件，它们不支持 DSH 本身的插件管理系统，也不加入 mynpm.staringplanet.top 的索引和重定向服务。

> 由于上游还尚处开发阶段，暂无稳定版本提供。

- [dsh-credentials-helper](https://github.com/Mooling0602/dsh-credentials-helper)（[中文](https://github.com/Mooling0602/dsh-credentials-helper/blob/main/README.zh.md)）

## LICENSE

MIT 仅适用于本仓库内容。每个插件有其各自的 LICENSE。

## 插件列表（DSH 插件 - TypeScript/JavaScript）

可以通过这个自定义插件索引源订阅和安装这里所列出的插件。不是我本人开发的插件也支持收录，欢迎提交 PR！

```plaintext
https://mynpm.staringplanet.top/dsh-plugins/index.json
```

由于索引源带有 npm 转换服务，因此不支持全部的特性（查看插件下载量、GitHub 星数等），但基础的信息查看和插件管理功能是完整的。

后续插件数量如果过多，列表可能会单独拆分到某个文档中。

> [!TIP]
> 推荐使用 GitHub release tarball 分发插件的开发者 PR 自己的插件元数据到本仓库，可以享受相同的索引和请求重定向服务，避免用户频繁手动复制新版本插件包链接到 DSH 中的麻烦。
>
> 对于普通用户，也推荐安装 [dsh-better-plugin-updater](https://github.com/Mooling0602/dsh-better-plugin-updater) 方便管理不受 DSH 插件包更新系统支持的插件（比如 GitHub 源）。

下面的内容是完整的推荐插件列表，将会由 CI 自动生成，并自动提交到仓库。

- [dsh-better-plugin-updater](https://github.com/Mooling0602/dsh-better-plugin-updater)（[中文](https://github.com/Mooling0602/dsh-better-plugin-updater/blob/main/README.zh.md)）
  ![](https://img.shields.io/badge/version-v0.1.2-blue) ![](https://img.shields.io/badge/ci-passing-brightgreen) ![](https://img.shields.io/badge/license-MIT-blue) ![](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.4_%3C0.3.0-4D6BFE)

- [dsh-bili-danmaku-overlay](https://github.com/Mooling0602/dsh-bili-danmaku-overlay)（[中文](https://github.com/Mooling0602/dsh-bili-danmaku-overlay/blob/main/README.md)）
  ![](https://img.shields.io/badge/version-v1.1.0-blue) ![](https://img.shields.io/badge/license-MIT-blue) ![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)

- [dsh-hint-shell](https://github.com/Mooling0602/dsh-hint-shell)（[中文](https://github.com/Mooling0602/dsh-hint-shell/blob/main/README.zh.md)）
  ![](https://img.shields.io/badge/version-v0.1.1-blue) ![](https://img.shields.io/badge/ci-passing-brightgreen) ![](https://img.shields.io/badge/license-MIT-blue)

- [dsh-mloader](https://github.com/Mooling0602/dsh-mloader)（[中文](https://github.com/Mooling0602/dsh-mloader/blob/main/README.zh.md)）
  ![](https://img.shields.io/badge/version-v0.1.0-blue) ![](https://img.shields.io/badge/license-LGPL--3.0--only-blue) ![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)

- [dsh-web-file-uploader](https://github.com/Mooling0602/dsh-web-file-uploader)（[中文](https://github.com/Mooling0602/dsh-web-file-uploader/blob/main/README_zh_CN.md)）
  ![](https://img.shields.io/badge/pre--release-v1.0.0--rc.3-orange) ![](https://img.shields.io/badge/ci-passing-brightgreen) ![](https://img.shields.io/badge/license-MIT-blue) ![](https://awesome-dsh-plugin.com/badge.svg)
