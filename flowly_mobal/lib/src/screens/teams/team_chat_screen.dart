import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:meu_app/src/app/flowly_theme.dart';
import 'package:meu_app/src/core/constants/storage_keys.dart';
import 'package:meu_app/src/models/chat_message.dart';
import 'package:meu_app/src/services/chat_attachments.dart';
import 'package:meu_app/src/services/chat_service.dart';
import 'package:meu_app/src/widgets/chat_attachment_widgets.dart';

class TeamChatScreen extends StatefulWidget {
  const TeamChatScreen({
    required this.teamId,
    required this.teamName,
    this.chatService,
    this.fileGateway,
    super.key,
  });

  final String teamId;
  final String teamName;

  /// Permite injetar o serviço nos testes; o app usa o padrão.
  final ChatService? chatService;

  /// Seletor e "Salvar como" nativos; substituível nos testes.
  final ChatFileGateway? fileGateway;

  @override
  State<TeamChatScreen> createState() => _TeamChatScreenState();
}

/// Última tentativa de envio de anexo: repetir o mesmo arquivo, legenda e equipe reaproveita o id.
class _AttachmentAttempt {
  const _AttachmentAttempt(this.fingerprint, this.clientMessageId);

  final String fingerprint;
  final String clientMessageId;
}

class _TeamChatScreenState extends State<TeamChatScreen> {
  static const int _imageCacheLimit = 40;

  late final ChatService _chatService = widget.chatService ?? ChatService();
  late final ChatFileGateway _files =
      widget.fileGateway ?? const ChatFileGateway();
  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  final TextEditingController _messageController = TextEditingController();
  final ScrollController _scrollController = ScrollController();

  List<ChatMessage> _messages = <ChatMessage>[];
  String _currentUserId = '';
  bool _loading = true;
  bool _sending = false;

  PickedChatFile? _draft;
  bool _uploading = false;
  double? _progress;
  CancelToken? _cancelToken;
  _AttachmentAttempt? _lastAttempt;
  bool _picking = false;
  StreamSubscription<void>? _reconnectSub;
  // Bytes das miniaturas só em memória (nunca em disco), com limite simples.
  final Map<String, Future<Uint8List>> _imageBytes =
      <String, Future<Uint8List>>{};

  bool get _busy => _sending || _uploading;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    final String userId = await _storage.read(key: StorageKeys.userId) ?? '';
    List<ChatMessage> history = <ChatMessage>[];
    bool historyFailed = false;
    try {
      history = await _chatService.carregarHistorico(widget.teamId);
    } catch (_) {
      historyFailed = true;
    }

    if (!mounted) {
      return;
    }

    setState(() {
      _currentUserId = userId;
      // Mescla com o que já chegou (resposta de envio ou socket), sem duplicar.
      _messages = mergeChatMessages(history, _messages);
      _loading = false;
    });
    if (historyFailed) {
      _showNotice(
        'Não foi possível carregar o histórico do chat.',
        color: flowlySecondary,
      );
    }

    _reconnectSub = _chatService.reconexoes.listen(
      (_) => _syncAfterReconnect(),
    );
    _chatService.conectar(
      equipeId: widget.teamId,
      onMessage: (ChatMessage message) {
        if (!mounted) {
          return;
        }
        setState(() {
          _messages = mergeChatMessages(_messages, <ChatMessage>[message]);
        });
        _scrollToBottom();
      },
    );

    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
  }

  // Reconexão: o que chegou enquanto o socket estava fora vem pelo histórico (?after=), sem duplicar.
  Future<void> _syncAfterReconnect() async {
    final DateTime? last = _messages
        .map((ChatMessage m) => m.createdAt)
        .whereType<DateTime>()
        .fold<DateTime?>(
          null,
          (DateTime? a, DateTime b) => a == null || b.isAfter(a) ? b : a,
        );
    try {
      final List<ChatMessage> missing = last == null
          ? await _chatService.carregarHistorico(widget.teamId)
          : await _chatService.carregarNovasMensagens(widget.teamId, last);
      if (!mounted || missing.isEmpty) {
        return;
      }
      setState(() => _messages = mergeChatMessages(_messages, missing));
      _scrollToBottom();
    } catch (_) {
      // Sem sincronização agora: a próxima reconexão ou a reabertura do chat recarrega o histórico.
    }
  }

  void _scrollToBottom() {
    if (!_scrollController.hasClients) {
      return;
    }
    _scrollController.animateTo(
      _scrollController.position.maxScrollExtent + 100,
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOut,
    );
  }

  void _showNotice(
    String message, {
    required Color color,
    String? title,
    SnackBarAction? action,
  }) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          action: action,
          // Com ação, o padrão seria ficar até ser dispensado e cobrir o composer.
          persist: false,
          content: title == null
              ? Text(message, style: const TextStyle(color: flowlyText))
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      title,
                      style: const TextStyle(
                        color: flowlyText,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    if (message.isNotEmpty)
                      Text(message, style: const TextStyle(color: flowlyText)),
                  ],
                ),
          backgroundColor: flowlySurfaceAlt,
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 6),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: BorderSide(color: color),
          ),
        ),
      );
  }

  void _showAttachmentError(
    ChatAttachmentException error, {
    VoidCallback? retry,
  }) {
    _showNotice(
      error.message,
      title: error.title,
      color: error.warning ? flowlyWarning : flowlySecondary,
      action: retry == null
          ? null
          : SnackBarAction(
              label: 'Tentar de novo',
              textColor: flowlyAccent,
              onPressed: retry,
            ),
    );
  }

  // ---------- Anexos: seleção ----------

  Future<void> _pickFile() async {
    if (_busy || _picking) {
      return;
    }
    _picking = true;
    PickedChatFile? file;
    try {
      file = await _files.pick();
    } catch (_) {
      if (mounted) {
        _showNotice(
          'Não foi possível abrir o seletor de arquivos.',
          color: flowlySecondary,
        );
      }
      return;
    } finally {
      _picking = false;
    }
    // Seleção cancelada: nada muda (o texto digitado continua).
    if (file == null || !mounted) {
      return;
    }
    final ChatAttachmentException? invalid = validateChatFile(file);
    if (invalid != null) {
      _showAttachmentError(invalid);
      return;
    }
    setState(() {
      _draft = file;
      _lastAttempt = null;
    });
  }

  void _removeDraft() {
    setState(() {
      _draft = null;
      _lastAttempt = null;
    });
    _files.clearTemporary();
  }

  // ---------- Anexos: envio ----------

  Future<void> _sendAttachment() async {
    final PickedChatFile? file = _draft;
    if (file == null || _busy || _currentUserId.isEmpty) {
      return;
    }
    final String legenda = _messageController.text.trim();
    final String fingerprint = '${widget.teamId}|${file.fingerprint}|$legenda';
    final String clientMessageId = _lastAttempt?.fingerprint == fingerprint
        ? _lastAttempt!.clientMessageId
        : newClientMessageId();
    _lastAttempt = _AttachmentAttempt(fingerprint, clientMessageId);
    final CancelToken cancelToken = CancelToken();

    setState(() {
      _uploading = true;
      _progress = null;
      _cancelToken = cancelToken;
    });

    try {
      final ChatAttachmentUploadResult result = await _chatService.enviarAnexo(
        equipeId: widget.teamId,
        file: file,
        clientMessageId: clientMessageId,
        legenda: legenda,
        cancelToken: cancelToken,
        onProgress: (double? value) {
          if (mounted && identical(_cancelToken, cancelToken)) {
            setState(() => _progress = value);
          }
        },
      );
      if (!mounted) {
        return;
      }
      setState(() {
        _messages = mergeChatMessages(_messages, <ChatMessage>[result.message]);
        _draft = null;
        _lastAttempt = null;
        _uploading = false;
        _progress = null;
        _cancelToken = null;
      });
      _messageController.clear();
      _files.clearTemporary();
      _scrollToBottom();
    } catch (error) {
      if (!mounted) {
        return;
      }
      final ChatAttachmentException failure = describeChatUploadError(error);
      setState(() {
        // 409: o id já foi usado com outro conteúdo; a próxima tentativa é um envio novo.
        if (failure.status == 409) {
          _lastAttempt = null;
        }
        _uploading = false;
        _progress = null;
        _cancelToken = null;
      });
      // Arquivo e legenda continuam para corrigir ou tentar de novo (sem repetição automática).
      // O aviso cobre o composer por alguns segundos: falhas recuperáveis trazem "Tentar de novo".
      final bool retryable = failure.warning || failure.status == 409;
      _showAttachmentError(
        failure,
        retry: retryable && _draft != null ? _sendAttachment : null,
      );
    }
  }

  void _cancelUpload() {
    _cancelToken?.cancel('Envio cancelado pela pessoa.');
  }

  // ---------- Anexos: visualização e download ----------

  Future<Uint8List> _loadAttachmentBytes(String path) {
    final Future<Uint8List>? cached = _imageBytes[path];
    if (cached != null) {
      return cached;
    }
    if (_imageBytes.length >= _imageCacheLimit) {
      _imageBytes.remove(_imageBytes.keys.first);
    }
    final Future<Uint8List> future = _chatService.baixarAnexo(path);
    _imageBytes[path] = future;
    // Falha não fica em cache: reabrir o chat tenta de novo.
    future.then<void>((_) {}, onError: (Object _) => _imageBytes.remove(path));
    return future;
  }

  Future<void> _download(ChatAttachment anexo) async {
    try {
      final Uint8List bytes = await _chatService.baixarAnexo(anexo.downloadUrl);
      final bool saved = await _files.save(
        safeDownloadName(anexo.nomeOriginal),
        bytes,
      );
      if (saved && mounted) {
        _showNotice('Arquivo salvo.', color: flowlySuccess);
      }
    } on ChatAttachmentException catch (error) {
      if (!error.canceled && mounted) {
        _showAttachmentError(error);
      }
    } catch (_) {
      if (mounted) {
        _showNotice(
          'Não foi possível salvar o arquivo.',
          color: flowlySecondary,
        );
      }
    }
  }

  // ---------- Texto (fluxo original) ----------

  // O texto só sai do campo quando o servidor confirma a gravação; recusa ou falha mantêm o rascunho.
  Future<void> _sendMessage() async {
    final String text = _messageController.text.trim();
    if (text.isEmpty || _currentUserId.isEmpty || _sending) {
      return;
    }

    setState(() => _sending = true);
    ChatSendResult result;
    try {
      result = await _chatService.enviarMensagem(
        equipeId: widget.teamId,
        texto: text,
      );
    } catch (_) {
      result = const ChatSendResult(
        ChatSendStatus.error,
        message: ChatSendResult.errorMessage,
      );
    }

    if (!mounted) {
      return;
    }
    setState(() => _sending = false);

    if (result.isSent) {
      _messageController.clear();
      return;
    }
    _showNotice(
      result.message,
      color: result.status == ChatSendStatus.uncertain
          ? flowlyWarning
          : flowlySecondary,
    );
  }

  void _submit() {
    if (_draft != null) {
      _sendAttachment();
    } else {
      _sendMessage();
    }
  }

  @override
  void dispose() {
    _cancelToken?.cancel('Chat fechado.');
    _reconnectSub?.cancel();
    _chatService.desconectar();
    if (_draft != null) {
      _files.clearTemporary();
    }
    _messageController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  String _formatTime(DateTime? date) {
    if (date == null) {
      return '';
    }
    final DateTime local = date.toLocal();
    String two(int v) => v.toString().padLeft(2, '0');
    return '${two(local.day)}/${two(local.month)} ${two(local.hour)}:${two(local.minute)}';
  }

  Widget _buildBubble(ChatMessage message) {
    final bool mine = message.userId == _currentUserId;
    final String time = _formatTime(message.createdAt);
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        constraints: const BoxConstraints(maxWidth: 300),
        decoration: BoxDecoration(
          color: mine ? flowlyPrimary.withValues(alpha: 0.9) : flowlySurfaceAlt,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: flowlyBorder),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            if (!mine)
              Text(
                message.userName,
                style: const TextStyle(
                  fontSize: 11,
                  color: flowlyAccent,
                  fontWeight: FontWeight.w700,
                ),
              ),
            if (message.isAttachment) ...<Widget>[
              ChatAttachmentContent(
                anexo: message.anexo!,
                loadBytes: _loadAttachmentBytes,
                onOpenImage: (ChatAttachment anexo, Uint8List bytes) =>
                    showChatImageViewer(context, anexo, bytes),
                onDownload: _download,
              ),
              if (message.texto.isNotEmpty) ...<Widget>[
                const SizedBox(height: 6),
                Text(message.texto, style: const TextStyle(color: flowlyText)),
              ],
            ] else
              Text(message.texto, style: const TextStyle(color: flowlyText)),
            if (time.isNotEmpty)
              Align(
                alignment: Alignment.centerRight,
                child: Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    time,
                    style: const TextStyle(
                      fontSize: 10,
                      color: flowlyMutedText,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final bool hasDraft = _draft != null;
    return Scaffold(
      appBar: AppBar(title: Text('Chat • ${widget.teamName}')),
      body: Column(
        children: <Widget>[
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.all(12),
                    itemCount: _messages.length,
                    itemBuilder: (BuildContext context, int index) =>
                        _buildBubble(_messages[index]),
                  ),
          ),
          Container(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 16),
            decoration: const BoxDecoration(
              color: flowlySurface,
              border: Border(top: BorderSide(color: flowlyBorder)),
            ),
            child: SafeArea(
              top: false,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  if (hasDraft)
                    ChatComposerAttachment(
                      file: _draft!,
                      uploading: _uploading,
                      progress: _progress,
                      onRemove: _removeDraft,
                      onReplace: _pickFile,
                      onCancel: _cancelUpload,
                    ),
                  Row(
                    children: <Widget>[
                      IconButton(
                        tooltip: 'Anexar arquivo (PNG, JPG ou PDF, até 10 MB)',
                        onPressed: _busy || _loading ? null : _pickFile,
                        icon: const Icon(
                          Icons.attach_file_rounded,
                          color: flowlyText,
                        ),
                      ),
                      Expanded(
                        child: TextField(
                          controller: _messageController,
                          readOnly: _busy,
                          maxLength: 4000,
                          minLines: 1,
                          maxLines: 4,
                          style: const TextStyle(color: flowlyText),
                          cursorColor: flowlyPrimary,
                          decoration: InputDecoration(
                            hintText: hasDraft
                                ? 'Adicione uma legenda (opcional)'
                                : 'Escreva uma mensagem... ',
                            hintStyle: const TextStyle(color: flowlyMutedText),
                            counterText: '',
                          ),
                          onSubmitted: (_) => _submit(),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton.filled(
                        tooltip: _busy
                            ? 'Enviando...'
                            : hasDraft
                            ? 'Enviar arquivo'
                            : 'Enviar',
                        onPressed: _busy ? null : _submit,
                        icon: _busy
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.send_rounded),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
