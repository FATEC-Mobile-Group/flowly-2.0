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

# Pesos do VGG-Face e do anti-spoofing (Fasnet) dentro da imagem, onde o DeepFace os procura ($DEEPFACE_HOME/.deepface/weights).
# Sem isto, cada instancia nova baixava ~553 MiB no primeiro login e os gravava no disco em memoria.
# As origens vem do DeepFace instalado; o arquivo so entra se tamanho e SHA-256 baterem com fetch_face_weights.py.
# O backend fica fixo em tensorflow: o DeepFace 0.0.105 tambem traz onnxruntime e, sem isto, poderia procurar o .onnx.
ENV DEEPFACE_HOME=/opt/deepface
ENV DEEPFACE_BACKEND_ENGINE=tensorflow
ENV FACE_REQUIRE_LOCAL_WEIGHTS=1
COPY fetch_face_weights.py ./
RUN python fetch_face_weights.py

COPY main.py check_opencv.py ./

ENV HOST=0.0.0.0
ENV PORT=8080
ENV FACE_MODEL=VGG-Face
ENV FACE_DETECTOR=opencv
ENV FACE_MATCH_THRESHOLD=0.4

# Barra a imagem se o OpenCV nao tiver os classificadores Haar ou se o DeepFace nao montar o detector.
RUN python check_opencv.py

# Barra a imagem se o VGG-Face ou o anti-spoofing nao carregarem da propria imagem com a rede desligada.
COPY check_face_model.py ./
RUN python check_face_model.py

# O worker carrega o modelo ao subir, antes de atender, e registra o tempo (log face_startup).
ENV FACE_PRELOAD_MODEL=1

EXPOSE 8080

# Cloud Run injeta PORT; gunicorn com 1 worker evita carregar o modelo várias vezes
CMD exec gunicorn --bind 0.0.0.0:${PORT:-8080} --workers 1 --threads 4 --timeout 120 main:app
