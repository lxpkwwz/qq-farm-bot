# 上游 NapCat 源码仓库已下线，:latest 是浮动标签且不再有可用性保证。生产部署请用
# --build-arg NAPCAT_IMAGE=mlikiowa/napcat-docker:<版本号> 固定版本，或先 docker load
# 归档的镜像 tar 再指向本地标签；两种做法见 docs/detailed-reference.md 的「部署细节」。
#
# NAPCAT_IMAGE 接受任意完整镜像地址，Docker Hub 直连超时时换成镜像加速站前缀即可，
# 例如 docker.m.daocloud.io/mlikiowa/napcat-docker:<版本号>（与 compose 里 NODE_IMAGE
# 用的是同一套写法）。注意 `docker manifest inspect` 由 CLI 直连 registry、不走宿主机的
# registry-mirrors，用它试标签只会一直超时；要验证标签是否存在请改用 docker pull。
ARG NAPCAT_IMAGE=mlikiowa/napcat-docker:latest
FROM ${NAPCAT_IMAGE}

COPY napcat/plugins/qq-miniapp-openauth /opt/qq-farm-bot/qq-miniapp-openauth
COPY napcat/docker-entrypoint.sh /usr/local/bin/qq-farm-napcat-entrypoint

RUN chmod +x /usr/local/bin/qq-farm-napcat-entrypoint

ENTRYPOINT ["/usr/local/bin/qq-farm-napcat-entrypoint"]
