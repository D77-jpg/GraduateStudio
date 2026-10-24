#!/usr/bin/env sh
# 开发期自检：Codex worker 内离线运行（依赖来自 /cache 缓存）。
# 注意：平台交付闸门会在干净副本上独立执行构建/测试/compose/冒烟，不依赖、也不信任本脚本。
set -e
cd "$(dirname "$0")"
REPO="${GS_M2_REPO:-$HOME/.m2/repository}"
MVN_OFFLINE="-o"
[ "${GS_VERIFY_ONLINE:-}" = "1" ] && MVN_OFFLINE=""

echo "== 后端：mvn test =="
(cd server && mvn -B -ntp -q $MVN_OFFLINE -Dmaven.repo.local="$REPO" test)

echo "== 前端：build + test =="
if [ ! -d client/node_modules ]; then
  echo "client/node_modules 不存在：开发容器无网络，无法安装前端依赖；前端检查交给平台交付闸门。"
else
  (cd client && npm run build && npm test)
fi
echo "gs-verify: OK"
