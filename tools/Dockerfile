FROM postgres:18-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apk add --no-cache python3 py3-pip \
 && pip install --break-system-packages "psycopg[binary]>=3.2"

WORKDIR /work

ENTRYPOINT ["python3", "-m", "tools.shardctl"]
