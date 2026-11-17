# Microserviço facial — Google Cloud Run / Docker
# Requer memória ≥ 2 GB (recomendado 4 GB) por causa do TensorFlow + DeepFace

FROM python:3.11-slim-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt constraints.txt ./
# Dependencias transitivas trazem outras variantes do OpenCV (opencv-python, opencv-contrib-python-headless...).
# Todas dividem a pasta cv2: desinstalar uma apaga arquivos das outras, inclusive os classificadores Haar.
# Por isso, depois de instalar todas as dependencias, as quatro variantes saem e so o headless volta,
# sem dependencias e na versao de constraints.txt.
RUN pip install --no-cache-dir -r requirements.txt \
    && pip uninstall -y opencv-python opencv-python-headless opencv-contrib-python opencv-contrib-python-headless \
    && pip install --no-cache-dir --no-deps -c constraints.txt opencv-python-headless

COPY main.py check_opencv.py ./

ENV HOST=0.0.0.0
ENV PORT=8080
ENV FACE_MODEL=VGG-Face
ENV FACE_DETECTOR=opencv
ENV FACE_MATCH_THRESHOLD=0.4

# Barra a imagem se o OpenCV nao tiver os classificadores Haar ou se o DeepFace nao montar o detector.
RUN python check_opencv.py

EXPOSE 8080

# Cloud Run injeta PORT; gunicorn com 1 worker evita carregar o modelo várias vezes
CMD exec gunicorn --bind 0.0.0.0:${PORT:-8080} --workers 1 --threads 4 --timeout 120 main:app
