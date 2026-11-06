#!/bin/sh
# install.sh —— ERP 销售仪表盘插件安装器（macOS / Linux 薄包装）
# 用法：
#   sh ./install.sh
#   sh ./install.sh --profile desktop --force
# 本脚本只做两件事：找到 node、把参数原样转给 install.mjs，并透传退出码。

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

find_node() {
    if command -v node >/dev/null 2>&1; then
        command -v node
        return 0
    fi
    for candidate in \
        /usr/local/bin/node \
        /opt/homebrew/bin/node \
        /usr/bin/node \
        "$HOME/.nvm/versions/node"/*/bin/node \
        "$HOME/.volta/bin/node"
    do
        if [ -x "$candidate" ]; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

NODE=$(find_node) || {
    echo ""
    echo "✘ 找不到 Node.js。"
    echo "  请先安装 Node.js 18 或更高版本：https://nodejs.org/"
    echo ""
    exit 1
}

exec "$NODE" "$SCRIPT_DIR/install.mjs" "$@"
