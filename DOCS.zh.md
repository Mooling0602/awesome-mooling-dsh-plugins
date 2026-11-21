# 插件索引文档

本仓库基于 [DSH 插件索引](https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market) 设计，通过在 CloudFlare Workers 托管的自定义插件索引提供 [awesome-mooling-dsh-plugins](README.zh.md) 内推荐的插件信息和安装服务。

本仓库所有代码和设计规范都可以用于参考，以编写属于你自己的项目。

要订阅 [awesome-mooling-dsh-plugins](README.zh.md) 的插件源，请在 DSH 的插件：发现中添加这个索引订阅链接。

```plaintext
https://mynpm.staringplanet.top/dsh-plugins/index.json
```

完成后将会显示推荐的插件列表到你的 DSH 中。你仍可以通过其他索引源或添加插件入口安装不在本仓库索引范围内的插件。

下面介绍本仓库要求的插件元数据规范，以及解析细则。

## 插件元数据格式

每个插件应只有一个元数据文件，并位于目录 `plugins/by-name/dsh-xx/dsh-xxfullname` 或 `plugins/by-name/xx/xxfullname` 下。虽然目前收录的插件数量不多，但这将为后续扩展大量插件的索引提供便利。

元数据文件需命名为 `plugin.yml`，并按以下格式编写：

```yaml
id: dsh-my-plugin
package: dsh-my-plugin
source: npm  # 目前仅支持 github|npm
repo: https://github.com/MyUserName/dsh-my-plugin
readme:
  zh_CN: README.zh.md  # 支持相对路径和完整链接
  en_US: README.md  # 支持相对路径和完整链接
  # 其他语言字段暂不支持，欢迎 PR，维护者未来也可能考虑进行扩展
dispatch-type: npmjs  # 目前支持 npmjs|source|tarball
```

这些信息将被用于生成临时插件列表 plugins.txt，然后通过 CloudFlare Workers 服务构建并缓存[索引数据](https://mynpm.staringplanet.top/dsh-plugins/index.json)，同时也会用于生成 [README](README.md) 及其翻译。

## 索引构建

索引不是手工编写的，而是由 CI 从插件元数据和生产环境实时读取的插件发行信息生成，再发布到 CloudFlare Workers 的 KV 存储中。整个流程由 `.github/workflows/registry.yml` 驱动，分两个有先后依赖的任务。

### 为什么会有一台 Workers

DSH 的插件索引格式中，一个版本只有两种来源：npm 包，或 git 仓库的某个提交。它没有“直接给一个 tarball 链接”这种来源类型。

而以 GitHub release tarball 分发的插件，其包往往并没有发布到 npm。为了让这类插件也能被索引收录并一键安装，本仓库自建了一台 CloudFlare Workers 充当只读 npm registry：

- 它把 GitHub release 资产转换成标准的 npm 包，让 pnpm 可以正常识别和安装
- 它把托管包的依赖反向代理到 `registry.npmjs.org`，其余包一律拒绝
- 索引本身也由它提供，因此客户端只需连接一个域名

第二条不是可选项。一个被转换的包，其 `peerDependencies` 仍然是普通的 npm 包，如果 Workers 只回答自己托管的包，安装过程就无法完成依赖解析。

但代理范围是受限的，只包括两类包：本仓库索引里收录的插件包本身，以及从它们出发能走到的依赖（直接依赖，以及依赖的依赖，如此递归）。如果任意包都能代理，这个域名就成了一个免费的公共 npm 镜像，任何人都可以拿它装任意包，消耗的是本项目的额度。判断逻辑在 `src/allow.ts`，结果按包名缓存在 KV 里：允许是永久的，拒绝则会在一天后过期，这样插件以后新增依赖时不会因为旧的拒绝记录而装不上。

### 数据流转

每一轮 CI 的步骤如下。

1. 构建 registry 数据。读取每个 `dispatch-type: tarball` 插件的 GitHub release 资产，按 tarball 的实际字节计算 integrity，生成对应的 packument 和 tarball 重定向表。
2. 先把 packument 批量写入 KV，再部署 Workers。顺序不能反，否则在部署切换的瞬间，客户端解析托管包会拿到 404 并把它记进自己的 lockfile。
3. 部署完成后，`build-index.sh` 会稀疏克隆对应版本的 DSH 源码仓库，用其中的索引生成器产出 `dists/index.json`。凡是 npm 形式的条目，都指向本仓库自己的 registry 地址。
4. 索引写入 KV 的 `__index__` 键。Workers 每次请求都重新读取该键，因此发布新索引不需要重新部署。

全过程中 `dists/` 都不会进入版本库：它是构建产物，KV 才是唯一的事实来源。这样也避免了“每次更新都要提交一个生成文件”的噪音提交。

### 为什么不走 npmjs 分发

把转换后的包发布到 npmjs 上，会让第三方可以覆盖同名包，也无法保证我们产出的包与我们索引描述的版本一致。自建 registry 让包的来源、版本和 integrity 全部由本仓库的 CI 决定，第三方无法介入。

元数据层面也同样收紧：`source: npm` 只允许搭配 `dispatch-type: npmjs`，指向其他第三方 npm 镜像会被直接拒绝。

### 本地验证

需要凭据的步骤只能由维护者本人执行。其余部分可以本地复现：

```plaintext
pnpm registry        # 生成 dists/registry/ 下的 packument 和 KV 批量文件
pnpm sources         # 从插件元数据重新生成 dists/plugins.txt
pnpm check           # 类型检查
pnpm test            # 运行测试
```

## 自述文档构建

仓库的自述文档（README）将包含完整的推荐插件列表，因此需要从模板生成。相关的模板文件在 `templates` 下。

由于大部分插件的插件名称（id）已经足以表达用途等信息，因此为节省篇幅，插件的介绍等额外信息将不会提供。会根据插件元数据，在插件名称下方自动添加合适的徽标，包括：

- 版本|tag(commit short hash)
- CI|passing or not
- 协议|MIT or other（自动通过 GitHub 接口识别，获取不到时不显示）
- 支持的 DSH 版本|^0.2.2-rc.1 or other
- 插件对应 README 中显式添加的没有重复的其他徽标

对于版本徽标，如果插件收录的是 GitHub release tarball 分发方式，则会显示为 Release|version，版本从对应提交里面的插件包信息取，减少弄错的可能性。如果存在比 latest-release 更新的 Pre-release，则会显示为 Pre-release|version。

插件名称部分显示链接到其源码仓库的插件名称，并根据当前所在自述文件的语言类型判断是否添加中文翻译的链接。

## 本地自述文档

`README.md` 和 `README.zh.md` 由 CI 生成并提交，在本地它们只是产物而不是输入。仓库内的 git hook 会把这两个文件标记为 `skip-worktree`，让本地修改不出现在 `git status` 里，避免误提交或与拉取冲突。

相关脚本在 `.githooks` 下：

- `.githooks/generated-readme on`：隐藏本地修改（hook 在切换分支和拉取后自动执行）
- `.githooks/generated-readme off`：取消隐藏，此时修改可见、可提交
- `.githooks/generated-readme reset`：丢弃本地修改，恢复成已提交的版本
- `.githooks/generated-readme status`：查看当前状态

需要手动修改自述文档时，先执行 `off` 再改，改完提交并推送，最后执行 `on`。`off` 的状态会一直保持，期间切换分支或拉取都不会被覆盖。

`skip-worktree` 有一个必须注意的限制：被标记的文件无法被 `git add`，加 `-f` 也一样，因为它不是忽略规则而是索引里的标记。直接改了却忘了 `off`，修改不会丢，但 hook 会提示你，`git status` 也看不到它。

CI 环境下不需要这套机制，工作流会通过 `SKIP_README_WORKTREE=1` 让它跳过。

## 贡献

欢迎你为本仓库提交 PR！在创建 fork 并打开 PR 之前，你需要遵循以下规范：

- 对于投递你所推荐的插件：使用 `feat: add or update plugin <dsh-plugin-id>` 例如 `feat: add or update plugin dsh-my-plugin` 作为提交信息和 PR 标题（PR 标题没有严格限制，提交信息会由 CI 检查并忽略正文内容，若不符规范且未处于 draft 状态，将被直接关闭）。对于 CI 通过的 PR，在 24 小时无人处理后，会推送 AI 审核并自动拒绝或合并。

> CI 实现将在后续 push 到仓库内，在此之前，一律走人工审查。

- 对于修改本仓库内的维护规范和部署系统，使用[约定式提交](https://www.conventionalcommits.org/zh-hans/v1.0.0/)，并在 PR 正文内用你所使用的语言说明清楚你的意图、修改内容和理由。这类提交直接由维护者本人亲自审查，并决定是否通过。

如不能认同或遵守以上规范，请不要投递 PR！