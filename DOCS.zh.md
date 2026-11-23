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

### 命名规则

`id` 和 `package` 会先于其他字段被检查，因为一个用不了的名字不是 CI 能延后处理的细节：

- `id` 必须匹配 `^[a-z][a-z0-9-]*$`：小写字母、数字和连字符，且以**字母**开头。它会成为插件的目录名，所以必须是目录能承载的名字。不接受大写字母，是因为 macOS 和 Windows 对比文件名时不区分大小写，`dsh-Foo` 和 `dsh-foo` 会是同一个目录。
- `id` 不能是 `dsh`、`dsh-plugin` 或 `dsh-plugins`。这几个名字在 npm 上由其他项目发布，插件若占用，会把读者引到别处。
- `package` 必须是 npm 接受的名字，允许带 scope：`^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$`。带 scope 的名字在 YAML 里必须加引号，因为裸 `@` 是保留值的起始符：`package: "@myscope/dsh-my-plugin"`。
- 两者都限制在 214 个字符以内，这是 npm 自己的上限。

被拒绝时，报错会指明字段、取值和规则，投稿不会在没说清违反了哪一条的情况下失败。

## 索引构建

索引不是手工编写的，而是由 CI 从插件元数据和插件自身的发行信息（GitHub release、npmjs 源，或插件的 Git 历史）生成，再随 Workers 一起部署出去。整个流程由 `.github/workflows/registry.yml` 驱动，分两个有先后依赖的任务。

### 为什么会有一台 Workers

DSH 的插件索引格式中，一个版本只有两种来源：npm 包，或 git 仓库的某个提交。它没有“直接给一个 tarball 链接”这种来源类型。

而以 GitHub release tarball 分发的插件，其包往往并没有发布到 npm。为了让这类插件也能被索引收录并一键安装，本仓库自建了一台 CloudFlare Workers 充当只读 npm registry：

- 它把 GitHub release 资产转换成标准的 npm 包，让 pnpm 可以正常识别和安装
- 它把托管包的依赖反向代理到 `registry.npmjs.org`，其余包一律拒绝
- 索引本身也由它提供，因此客户端只需连接一个域名

第二条不是可选项。一个被转换的包，其 `peerDependencies` 仍然是普通的 npm 包，如果 Workers 只回答自己托管的包，安装过程就无法完成依赖解析。

但代理范围是受限的，只包括两类包：本仓库索引里收录的插件包本身，以及从它们出发能走到的依赖（直接依赖，以及依赖的依赖，如此递归）。如果任意包都能代理，这个域名就成了一个免费的公共 npm 镜像，任何人都可以拿它装任意包，消耗的是本项目的额度。判断逻辑在 `src/allow.ts`，结果按包名缓存在 KV 里：允许是永久的，拒绝则会在一天后过期，这样插件以后新增依赖时不会因为旧的拒绝记录而装不上。

这些缓存记录都是派生数据，所以每次部署都会先删掉重建（`.github/workflows/registry.yml` 里调用 `node src/registry/build.ts --cache-plan`）。原因是有过教训：早期版本只读 `latest` 版本的依赖，拒绝了一批实际要装的包，而拒绝记录当时没有过期时间，于是它们在 bug 修好之后继续拦着安装，只能手工清理。重建让这类错误自己痊愈，代价是发布后的第一次安装要重新走一遍依赖图——实测最慢的托管插件冷装约 30 秒，热装约 7 秒。

### 数据流转

每一轮 CI 的步骤如下。

1. 构建 registry 数据。读取每个 `dispatch-type: tarball` 插件的 GitHub release 资产，按 tarball 的实际字节计算 integrity，生成对应的 packument，以及一张从版本号到资产地址的映射表。
2. 构建索引。`build-index.sh` 只是检查输入是否就位的薄封装，真正干活的是 `node src/index/build.ts`：它先读本仓库的元数据，再按 dispatch 类型分别读 GitHub release API、npmjs 源，或插件自己的 Git 历史。凡是 npm 形式的条目，都记录本仓库自己的 registry 地址，所以版本列表虽然读自 GitHub，客户端安装时仍然走代理。
3. 先部署 Workers，再批量写入 packument。顺序是刻意反过来的：写入放在前面时，一旦某天免费计划的 KV 写入配额耗尽，连和 KV 无关的 Workers 改动都发不出去；而数据落后一个版本的 Workers 仍然是能用的 Workers，旧 packument 还在 KV 里，照常解析。代价是本次发布的新版本在写入成功前查不到，所以上传失败必须让整个任务失败。

索引本身不是 KV 记录，而是编译进 Workers 脚本的，随部署直接到达用户，刷新它不消耗任何 KV 写入。这是有意的：索引原本是一次 KV 写入，要和 packument 上传共用很小的每日配额，某天配额耗尽时，新索引明明算对了，用户却仍然停在旧索引上。现在索引仍可能过期，但只会在部署失败期间过期——那是看得见的——而不是在配额耗尽的整段时间里过期，那是看不见的。

全过程中 `dists/` 都不会进入版本库：它是构建产物。这样也避免了“每次更新都要提交一个生成文件”的噪音提交。本地检出还没有索引时，`src/index/ensure.ts` 会按需生成它，`pnpm check` 和 `pnpm test` 因此在全新克隆上也能直接跑。

索引的构建过程不问 Workers 该列哪些插件。这对首次部署很关键：Workers 还没部署时并不存在，一个要靠 Workers 提供输入的索引永远没法为那次部署构建出来。所有输入都来自 GitHub 或 npmjs，这些在 Workers 存在之前就能访问。

### 写入配额耗尽究竟影响什么

免费计划对 KV 写入设有每日上限。达到上限时上传步骤会失败，任务会显示为失败而不是通过——一次没有发布出去的发布，不能让任务看起来是成功的。但实际影响范围比一片失败的红色要窄：

| 操作 | 配额耗尽时 |
| --- | --- |
| 读取已在 KV 里的 packument | 正常 |
| 下载已有版本的 tarball | 正常 |
| 安装已发布过的版本 | 正常 |
| 安装本轮刚发布的版本 | 失败 |
| 安装本轮新加的插件 | 失败，返回 404 |

配额只管写入，读取不受影响，所以 KV 里已有的内容照常提供。真正坏掉的正是没写进去的那部分：一个新插件，或一个已有插件的新版本。客户端请求 worker 不托管的包时也不会被转发到 npmjs，因为代理只对托管包的依赖开放；它拿到的就是 404。这就是为什么故障表现是“这个插件装不上”，而不是“装成了别的东西”。

索引完全不受影响，因为它编译在 Workers 脚本里，在上传步骤执行之前就已经部署上去了。于是用户会看到新索引里列着一个 packument 没送达的插件——这是唯一值得知道的不一致：在当天剩下的时间里，列表和可安装性会说不同的话。

配额重置后重跑一次 workflow 就能补完这次发布，不需要先撤销任何东西，因为上传会覆盖同样的键。

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

投稿的 pull request 不需要改动它们。这两个文件由 `plugins/` 生成，并在 `main` 上由 `readme.yml` 重写；要求 PR 自带重新生成的副本，等于让投稿者提供一份仓库在本地替他藏起来的产物，而 fork 也无法把它推回来。README 在合并之后再跟上即可。

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

- 对于投递你所推荐的插件：PR **必须指向 `main` 分支**，且只包含一个插件元数据文件 `plugins/by-name/<分片>/<插件 id>/plugin.yml`。指向其他分支，或在同一个 PR 里既投递插件又改动仓库本身，都会被直接关闭，draft 状态也不例外。
- `<分片>` 是该插件 id 去掉 `dsh-` 前缀后的前两个字母，写不写 `dsh-` 前缀都可以，但必须和插件目录名保持一致：`dsh-mloader` 放在 `dsh-ml/` 或 `ml/` 下都行，但不能是 `dsh-mloader` 放在 `ml/` 下。
- 提交 **PR 标题**使用 `feat: add or update plugin <dsh-plugin-id>`，例如 `feat: add or update plugin dsh-my-plugin`。CI 只检查标题，因为投稿会以标题作为提交信息压缩合并，标题才是插件索引记录的内容。分支内的提交信息可以随意写，只有不符合约定式提交时才会给出一条警告，警告不会让 CI 失败。PR 正文完全不读取。合并始终由维护者手动操作；不符合上述规则、或指向其他分支的投稿，仍会按前文所述被自动关闭。
- 对于修改本仓库内的维护规范和部署系统，使用[约定式提交](https://www.conventionalcommits.org/zh-hans/v1.0.0/)，并在 PR 正文内用你所使用的语言说明清楚你的意图、修改内容和理由。这类提交直接由维护者本人亲自审查，并决定是否通过。

> 建议创建 PR 时先打开为 draft，避免 CI 失败被直接拒绝。CI 通过后再转成 ready。CI 通过后，PR 上会出现一条评论，用表格列出每一项检查的结果。

> PR 一旦被关闭，本仓库不会再追加任何评论——关闭本身就是完整的答复。

如不能认同或遵守以上规范，请不要投递 PR！