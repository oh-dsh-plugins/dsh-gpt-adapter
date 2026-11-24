# DSH 0.2.3-alpha.1

DSH `0.2.3-alpha.1` needs corrected host dependencies before it can load plugins. The host manifest and pnpm lockfile in this directory pin the compatible Cordis, Loader, Include, Group, Schemastery, and Cosmokit versions. Verified with Node.js `24.22.3` and pnpm `10.26.0`.

DSH `0.2.3-alpha.1` 需要先修正宿主依赖，才能加载插件。此目录的清单与 pnpm 锁文件固定了验收通过的配套依赖。以下命令会在独立目录安装宿主和插件，并启动单独的 Web 配置档。

```sh
git clone --depth 1 --branch v0.2.20 https://github.com/oh-dsh-plugins/dsh-gpt-adapter.git
cd dsh-gpt-adapter/scripts/alpha1-host
pnpm install --frozen-lockfile --ignore-scripts

alpha1_dsh="$PWD/node_modules/.bin/dsh"
alpha1_state="$(mktemp -d)"
export DSH_HOME="$alpha1_state/dsh"
export DSH_AGENTS_HOME="$alpha1_state/agents"
"$alpha1_dsh" plugin --profile web add dsh-gpt-adapter@0.2.20
"$alpha1_dsh" --profile web --no-open --host 127.0.0.1 --port 0
```

Open the local URL printed by DSH. To reuse the same profile after restarting, set the two DSH paths to the same directories.

打开 DSH 打印的本地地址。重启后要继续使用同一配置档，请将上面的两个 DSH 路径设回同一目录。
