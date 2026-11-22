import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:meu_app/src/app/flowly_theme.dart';
import 'package:meu_app/src/core/constants/storage_keys.dart';
import 'package:meu_app/src/models/chat_message.dart';
import 'package:meu_app/src/services/chat_service.dart';

class TeamChatScreen extends StatefulWidget {
  const TeamChatScreen({
    required this.teamId,
    required this.teamName,
    this.chatService,
    super.key,
  });

  final String teamId;
  final String teamName;

  /// Permite injetar o serviço nos testes; o app usa o padrão.
  final ChatService? chatService;

  @override
  State<TeamChatScreen> createState() => _TeamChatScreenState();
}

class _TeamChatScreenState extends State<TeamChatScreen> {
  late final ChatService _chatService = widget.chatService ?? ChatService();
  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  final TextEditingController _messageController = TextEditingController();
  final ScrollController _scrollController = ScrollController();

  List<ChatMessage> _messages = <ChatMessage>[];
  String _currentUserId = '';
  bool _loading = true;
  bool _sending = false;

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
      _messages = history;
      _loading = false;
    });
    if (historyFailed) {
      _showNotice(
        'Não foi possível carregar o histórico do chat.',
        color: flowlySecondary,
      );
    }

    _chatService.conectar(
      equipeId: widget.teamId,
      onMessage: (ChatMessage message) {
        if (!mounted) {
          return;
        }
        setState(() {
          _messages = <ChatMessage>[..._messages, message];
        });
        _scrollToBottom();
      },
    );

    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
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

  void _showNotice(String message, {required Color color}) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(message, style: const TextStyle(color: flowlyText)),
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

  @override
  void dispose() {
    _chatService.desconectar();
    _messageController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
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
                    itemBuilder: (BuildContext context, int index) {
                      final ChatMessage message = _messages[index];
                      final bool mine = message.userId == _currentUserId;

                      return Align(
                        alignment: mine
                            ? Alignment.centerRight
                            : Alignment.centerLeft,
                        child: Container(
                          margin: const EdgeInsets.only(bottom: 8),
                          padding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 10,
                          ),
                          constraints: const BoxConstraints(maxWidth: 300),
                          decoration: BoxDecoration(
                            color: mine
                                ? flowlyPrimary.withValues(alpha: 0.9)
                                : flowlySurfaceAlt,
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
                              Text(
                                message.texto,
                                style: const TextStyle(color: flowlyText),
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
          ),
          Container(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 16),
            decoration: const BoxDecoration(
              color: flowlySurface,
              border: Border(top: BorderSide(color: flowlyBorder)),
            ),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: TextField(
                    controller: _messageController,
                    readOnly: _sending,
                    maxLength: 4000,
                    minLines: 1,
                    maxLines: 4,
                    style: const TextStyle(color: flowlyText),
                    cursorColor: flowlyPrimary,
                    decoration: const InputDecoration(
                      hintText: 'Escreva uma mensagem... ',
                      hintStyle: TextStyle(color: flowlyMutedText),
                      counterText: '',
                    ),
                    onSubmitted: (_) => _sendMessage(),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  tooltip: _sending ? 'Enviando...' : 'Enviar',
                  onPressed: _sending ? null : _sendMessage,
                  icon: _sending
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.send_rounded),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
