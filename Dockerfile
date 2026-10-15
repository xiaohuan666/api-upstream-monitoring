FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5173
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tools/oauth_login/requirements.txt /tmp/oauth-login-requirements.txt
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl python3 python3-venv \
  && python3 -m venv /opt/ocr-venv \
  && /opt/ocr-venv/bin/pip install --no-cache-dir "ddddocr==1.6.1" \
  && python3 -m venv /opt/oauth-login-venv \
  && /opt/oauth-login-venv/bin/pip install --no-cache-dir -r /tmp/oauth-login-requirements.txt \
  && rm -rf /var/lib/apt/lists/* /tmp/oauth-login-requirements.txt
ENV OCR_PYTHON=/opt/ocr-venv/bin/python
ENV OAUTH_LOGIN_PYTHON=/opt/oauth-login-venv/bin/python

COPY server.mjs index.html styles.css ./
COPY src ./src
COPY tools ./tools

EXPOSE 5173

CMD ["node", "server.mjs"]
