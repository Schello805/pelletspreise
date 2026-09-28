FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY --chown=pwuser:pwuser . .
RUN mkdir -p /app/server/data && chown -R pwuser:pwuser /app/server/data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    DEPLOYMENT_MODE=caprover \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

USER pwuser

EXPOSE 8000
VOLUME ["/app/server/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]
