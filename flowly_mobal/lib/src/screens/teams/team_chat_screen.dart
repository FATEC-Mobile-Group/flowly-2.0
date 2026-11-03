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
    super.key,
  });

  final String teamId;
  final String teamName;

  @override
  State<TeamChatScreen> createState() => _TeamChatScreenState();
}

class _TeamChatScreenState extends State<TeamChatScreen> {
  final ChatService _chatService = ChatService();
  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  final TextEditingController _messageController = TextEditingController();
  final ScrollController _scrollController = ScrollController();

  List<ChatMessage> _messages = <ChatMessage>[];
  String _currentUserId = '';
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    final String userId = await _storage.read(key: StorageKeys.userId) ?? '';
    final List<ChatMessage> history = await _chatService.carregarHistorico(
      widget.teamId,
    );

    if (!mounted) {
      return;
    }

    setState(() {
      _currentUserId = userId;
      _messages = history;
      _loading = false;
    });

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

  void _sendMessage() {
    final String text = _messageController.text.trim();
    if (text.isEmpty || _currentUserId.isEmpty) {
      return;
    }

    _chatService.enviarMensagem(equipeId: widget.teamId, texto: text);

    _messageController.clear();
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
                    minLines: 1,
                    maxLines: 4,
                    style: const TextStyle(color: flowlyText),
                    cursorColor: flowlyPrimary,
                    decoration: const InputDecoration(
                      hintText: 'Escreva uma mensagem... ',
                      hintStyle: TextStyle(color: flowlyMutedText),
                    ),
                    onSubmitted: (_) => _sendMessage(),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  onPressed: _sendMessage,
                  icon: const Icon(Icons.send_rounded),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
