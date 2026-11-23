import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:meu_app/src/app/flowly_theme.dart';
import 'package:meu_app/src/models/chat_message.dart';
import 'package:meu_app/src/services/chat_attachments.dart';

typedef AttachmentBytesLoader = Future<Uint8List> Function(String path);

/// Conteúdo de uma mensagem com anexo: imagem (miniatura autenticada, ampliar, baixar) ou card de
/// documento (ícone, nome, tamanho, baixar). PDF nunca é renderizado dentro do app.
class ChatAttachmentContent extends StatelessWidget {
  const ChatAttachmentContent({
    required this.anexo,
    required this.loadBytes,
    required this.onOpenImage,
    required this.onDownload,
    super.key,
  });

  final ChatAttachment anexo;
  final AttachmentBytesLoader loadBytes;
  final void Function(ChatAttachment anexo, Uint8List bytes) onOpenImage;
  final Future<void> Function(ChatAttachment anexo) onDownload;

  @override
  Widget build(BuildContext context) {
    final Widget meta = Row(
      children: <Widget>[
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                anexo.nomeOriginal,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: flowlyText,
                  fontWeight: FontWeight.w600,
                  fontSize: 13,
                ),
              ),
              Text(
                formatChatBytes(anexo.size),
                style: const TextStyle(color: flowlyMutedText, fontSize: 11),
              ),
            ],
          ),
        ),
        _DownloadButton(anexo: anexo, onDownload: onDownload),
      ],
    );

    if (anexo.isImage && anexo.previewUrl != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _AuthorizedImage(
            anexo: anexo,
            loadBytes: loadBytes,
            onOpen: onOpenImage,
          ),
          const SizedBox(height: 6),
          meta,
        ],
      );
    }
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.18),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: <Widget>[
          Container(
            width: 40,
            height: 40,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: flowlyPrimary.withValues(alpha: 0.25),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(
              anexo.isImage
                  ? Icons.image_outlined
                  : Icons.picture_as_pdf_outlined,
              color: flowlyText,
              semanticLabel: anexo.isImage ? 'Imagem' : 'Documento PDF',
            ),
          ),
          const SizedBox(width: 10),
          Expanded(child: meta),
        ],
      ),
    );
  }
}

class _AuthorizedImage extends StatefulWidget {
  const _AuthorizedImage({
    required this.anexo,
    required this.loadBytes,
    required this.onOpen,
  });

  final ChatAttachment anexo;
  final AttachmentBytesLoader loadBytes;
  final void Function(ChatAttachment anexo, Uint8List bytes) onOpen;

  @override
  State<_AuthorizedImage> createState() => _AuthorizedImageState();
}

class _AuthorizedImageState extends State<_AuthorizedImage> {
  late Future<Uint8List> _bytes = widget.loadBytes(widget.anexo.previewUrl!);

  @override
  void didUpdateWidget(covariant _AuthorizedImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.anexo.previewUrl != widget.anexo.previewUrl) {
      _bytes = widget.loadBytes(widget.anexo.previewUrl!);
    }
  }

  Widget _placeholder(Widget child) => Container(
    width: 220,
    height: 140,
    alignment: Alignment.center,
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: Colors.black.withValues(alpha: 0.18),
      borderRadius: BorderRadius.circular(10),
    ),
    child: child,
  );

  Widget _failure(String message) => _placeholder(
    Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        const Icon(Icons.broken_image_outlined, color: flowlyMutedText),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            message,
            style: const TextStyle(color: flowlyMutedText, fontSize: 12),
          ),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Uint8List>(
      future: _bytes,
      builder: (BuildContext context, AsyncSnapshot<Uint8List> snapshot) {
        if (snapshot.hasError) {
          return _failure(describeChatDownloadError(snapshot.error!).message);
        }
        final Uint8List? bytes = snapshot.data;
        if (bytes == null) {
          return _placeholder(
            Semantics(
              label: 'Carregando imagem',
              child: const SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
          );
        }
        return Semantics(
          button: true,
          label: 'Ampliar imagem ${widget.anexo.nomeOriginal}',
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => widget.onOpen(widget.anexo, bytes),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  maxHeight: 240,
                  maxWidth: 276,
                ),
                child: Image.memory(
                  bytes,
                  fit: BoxFit.cover,
                  gaplessPlayback: true,
                  excludeFromSemantics: true,
                  errorBuilder: (_, _, _) =>
                      _failure('Não foi possível exibir a imagem.'),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

class _DownloadButton extends StatefulWidget {
  const _DownloadButton({required this.anexo, required this.onDownload});

  final ChatAttachment anexo;
  final Future<void> Function(ChatAttachment anexo) onDownload;

  @override
  State<_DownloadButton> createState() => _DownloadButtonState();
}

class _DownloadButtonState extends State<_DownloadButton> {
  bool _busy = false;

  Future<void> _download() async {
    if (_busy) {
      return;
    }
    setState(() => _busy = true);
    try {
      await widget.onDownload(widget.anexo);
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return IconButton(
      tooltip: 'Baixar ${widget.anexo.nomeOriginal}',
      onPressed: _busy ? null : _download,
      icon: _busy
          ? const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.download_rounded, color: flowlyText),
    );
  }
}

/// Imagem ampliada (gesto de pinça), fechada pelo botão ou pelo voltar do sistema.
Future<void> showChatImageViewer(
  BuildContext context,
  ChatAttachment anexo,
  Uint8List bytes,
) {
  return showDialog<void>(
    context: context,
    barrierColor: Colors.black87,
    builder: (BuildContext context) => Dialog(
      backgroundColor: Colors.transparent,
      insetPadding: const EdgeInsets.all(12),
      child: Semantics(
        label: 'Imagem ${anexo.nomeOriginal}',
        child: Stack(
          children: <Widget>[
            Center(
              child: InteractiveViewer(
                maxScale: 5,
                child: Image.memory(
                  bytes,
                  fit: BoxFit.contain,
                  errorBuilder: (_, _, _) => const Text(
                    'Não foi possível exibir a imagem.',
                    style: TextStyle(color: flowlyText),
                  ),
                ),
              ),
            ),
            Positioned(
              top: 0,
              right: 0,
              child: IconButton.filled(
                tooltip: 'Fechar imagem',
                onPressed: () => Navigator.of(context).pop(),
                icon: const Icon(Icons.close_rounded),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

/// Arquivo escolhido, antes do envio: miniatura local (imagem) ou ícone (PDF), nome, tamanho e ações.
class ChatComposerAttachment extends StatelessWidget {
  const ChatComposerAttachment({
    required this.file,
    required this.uploading,
    required this.progress,
    required this.onRemove,
    required this.onReplace,
    required this.onCancel,
    super.key,
  });

  final PickedChatFile file;
  final bool uploading;
  final double? progress;
  final VoidCallback onRemove;
  final VoidCallback onReplace;
  final VoidCallback onCancel;

  Widget _thumbnail() {
    const Widget fallback = Icon(Icons.image_outlined, color: flowlyText);
    if (!file.isImage) {
      return const Icon(
        Icons.picture_as_pdf_outlined,
        color: flowlyText,
        semanticLabel: 'Documento PDF',
      );
    }
    final Widget image = file.bytes != null
        ? Image.memory(
            file.bytes!,
            fit: BoxFit.cover,
            errorBuilder: (_, _, _) => fallback,
          )
        : Image.file(
            File(file.path!),
            fit: BoxFit.cover,
            cacheWidth: 112,
            errorBuilder: (_, _, _) => fallback,
          );
    return ClipRRect(borderRadius: BorderRadius.circular(8), child: image);
  }

  @override
  Widget build(BuildContext context) {
    final int? percent = progress == null ? null : (progress! * 100).round();
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(10, 8, 4, 8),
      decoration: BoxDecoration(
        color: flowlySurfaceAlt,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: flowlyBorder),
      ),
      child: Row(
        children: <Widget>[
          Container(
            width: 48,
            height: 48,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: flowlyPrimary.withValues(alpha: 0.2),
              borderRadius: BorderRadius.circular(8),
            ),
            child: SizedBox.expand(child: _thumbnail()),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  file.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: flowlyText,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  formatChatBytes(file.size),
                  style: const TextStyle(color: flowlyMutedText, fontSize: 12),
                ),
                if (uploading) ...<Widget>[
                  const SizedBox(height: 6),
                  Row(
                    children: <Widget>[
                      Expanded(
                        child: LinearProgressIndicator(
                          value: progress,
                          minHeight: 5,
                          borderRadius: BorderRadius.circular(4),
                          semanticsLabel: 'Enviando ${file.name}',
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        percent == null ? 'Enviando...' : '$percent%',
                        style: const TextStyle(
                          color: flowlyMutedText,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
          if (uploading)
            TextButton(
              onPressed: onCancel,
              child: Text(
                'Cancelar',
                semanticsLabel: 'Cancelar envio de ${file.name}',
              ),
            )
          else ...<Widget>[
            IconButton(
              tooltip: 'Trocar arquivo',
              onPressed: onReplace,
              icon: const Icon(Icons.swap_horiz_rounded, color: flowlyText),
            ),
            IconButton(
              tooltip: 'Remover arquivo',
              onPressed: onRemove,
              icon: const Icon(Icons.close_rounded, color: flowlyText),
            ),
          ],
        ],
      ),
    );
  }
}
