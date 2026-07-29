FROM nvidia/cuda:12.8.0-cudnn-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3.12 python3-pip libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN python3.12 -m pip install --break-system-packages --upgrade pip \
    && python3.12 -m pip install --break-system-packages --index-url https://download.pytorch.org/whl/cu128 torch \
    && python3.12 -m pip install --break-system-packages -r requirements.txt

COPY app.py ./

EXPOSE 8001
CMD ["python3.12", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
