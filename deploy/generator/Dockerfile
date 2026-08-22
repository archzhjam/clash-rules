FROM node:20-alpine

RUN apk add --no-cache git openssh-client bash

WORKDIR /app
COPY generate.mjs config.example.json ./
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# SSH 密钥挂载点（用于 git push 到私有仓库）
RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
