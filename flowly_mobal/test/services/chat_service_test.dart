import 'package:flutter_test/flutter_test.dart';
import 'package:meu_app/src/services/chat_service.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

/// Socket falso: registra os envios e os ouvintes, sem rede.
class _FakeSocket implements io.Socket {
  _FakeSocket({this.isConnected = true});

  final bool isConnected;
  final List<Map<String, dynamic>> sent = <Map<String, dynamic>>[];
  final Map<String, List<dynamic Function(dynamic)>> listeners =
      <String, List<dynamic Function(dynamic)>>{};
  Function? lastAck;

  @override
  bool get connected => isConnected;

  @override
  void emitWithAck(
    String event,
    dynamic data, {
    Function? ack,
    bool binary = false,
  }) {
    sent.add(<String, dynamic>{'event': event, 'data': data});
    lastAck = ack;
  }

  @override
  Function() on(String event, dynamic Function(dynamic) handler) {
    listeners
        .putIfAbsent(event, () => <dynamic Function(dynamic)>[])
        .add(handler);
    return () => off(event, handler);
  }

  @override
  void off(String event, [dynamic Function(dynamic)? handler]) {
    listeners[event]?.remove(handler);
  }

  void trigger(String event, [dynamic data]) {
    for (final dynamic Function(dynamic) handler
        in List<dynamic Function(dynamic)>.of(
          listeners[event] ?? <dynamic Function(dynamic)>[],
        )) {
      handler(data);
    }
  }

  int listenerCount() => listeners.values.fold<int>(
    0,
    (int total, List<dynamic> list) => total + list.length,
  );

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  const String equipeId = '507f1f77bcf86cd799439099';

  group('ChatSendResult.fromAck', () {
    test('ok vira enviado com o id da mensagem', () {
      final ChatSendResult result = ChatSendResult.fromAck(<String, dynamic>{
        'ok': true,
        'messageId': 'm1',
      });

      expect(result.isSent, isTrue);
      expect(result.messageId, 'm1');
    });

    test('bloqueio traz a explicação do servidor', () {
      final ChatSendResult result = ChatSendResult.fromAck(<dynamic, dynamic>{
        'ok': false,
        'blocked': true,
        'reason': 'unsafe_content',
        'message': 'Parece conter um insulto.',
      });

      expect(result.status, ChatSendStatus.blocked);
      expect(result.message, 'Parece conter um insulto.');
    });

    test('erro sem mensagem usa um texto padrão e nunca vira enviado', () {
      final ChatSendResult result = ChatSendResult.fromAck(<String, dynamic>{
        'ok': false,
        'reason': 'send_failed',
      });

      expect(result.status, ChatSendStatus.error);
      expect(result.message, ChatSendResult.errorMessage);
    });

    test('resposta malformada é tratada como erro', () {
      expect(ChatSendResult.fromAck(null).status, ChatSendStatus.error);
      expect(ChatSendResult.fromAck('ok').status, ChatSendStatus.error);
    });

    test('aceita o ACK embrulhado em lista', () {
      final ChatSendResult result = ChatSendResult.fromAck(<dynamic>[
        <String, dynamic>{'ok': true, 'messageId': 'm2'},
      ]);

      expect(result.isSent, isTrue);
    });
  });

  group('sendChatMessageWithAck', () {
    test('emite uma vez e conclui como enviado ao receber o ACK', () async {
      final _FakeSocket socket = _FakeSocket();
      final Future<ChatSendResult> pending = sendChatMessageWithAck(
        socket,
        equipeId: equipeId,
        texto: 'Bom dia',
      );

      expect(socket.sent, hasLength(1));
      expect(socket.sent.single['event'], 'send_message');
      expect(socket.sent.single['data'], <String, dynamic>{
        'equipeId': equipeId,
        'texto': 'Bom dia',
      });

      socket.lastAck!(<String, dynamic>{'ok': true, 'messageId': 'm1'});
      final ChatSendResult result = await pending;

      expect(result.isSent, isTrue);
      expect(socket.listenerCount(), 0);
    });

    test('bloqueio pelo ACK mantém a explicação', () async {
      final _FakeSocket socket = _FakeSocket();
      final Future<ChatSendResult> pending = sendChatMessageWithAck(
        socket,
        equipeId: equipeId,
        texto: 'texto recusado',
      );

      socket.lastAck!(<String, dynamic>{
        'ok': false,
        'blocked': true,
        'message': 'Parece conter uma ameaça.',
      });
      final ChatSendResult result = await pending;

      expect(result.status, ChatSendStatus.blocked);
      expect(result.message, 'Parece conter uma ameaça.');
    });

    test('servidor sem ACK: message_blocked conclui como bloqueado', () async {
      final _FakeSocket socket = _FakeSocket();
      final Future<ChatSendResult> pending = sendChatMessageWithAck(
        socket,
        equipeId: equipeId,
        texto: 'texto recusado',
      );

      socket.trigger('message_blocked', <String, dynamic>{
        'reason': 'unsafe_content',
        'message': 'Mensagem bloqueada por seguranca.',
      });
      final ChatSendResult result = await pending;

      expect(result.status, ChatSendStatus.blocked);
      expect(result.message, 'Mensagem bloqueada por seguranca.');
      expect(socket.listenerCount(), 0);
    });

    test('desconectado não emite nada', () async {
      final _FakeSocket socket = _FakeSocket(isConnected: false);

      final ChatSendResult result = await sendChatMessageWithAck(
        socket,
        equipeId: equipeId,
        texto: 'Bom dia',
      );

      expect(result.status, ChatSendStatus.offline);
      expect(socket.sent, isEmpty);
      expect(
        (await sendChatMessageWithAck(
          null,
          equipeId: equipeId,
          texto: 'x',
        )).status,
        ChatSendStatus.offline,
      );
    });

    test('sem resposta no prazo vira incerto, sem reenviar', () async {
      final _FakeSocket socket = _FakeSocket();

      final ChatSendResult result = await sendChatMessageWithAck(
        socket,
        equipeId: equipeId,
        texto: 'Bom dia',
        timeout: const Duration(milliseconds: 20),
      );

      expect(result.status, ChatSendStatus.uncertain);
      expect(socket.sent, hasLength(1));
      expect(socket.listenerCount(), 0);
    });

    test('queda da conexão durante o envio vira incerto', () async {
      final _FakeSocket socket = _FakeSocket();
      final Future<ChatSendResult> pending = sendChatMessageWithAck(
        socket,
        equipeId: equipeId,
        texto: 'Bom dia',
      );

      socket.trigger('disconnect', 'transport close');
      final ChatSendResult result = await pending;

      expect(result.status, ChatSendStatus.uncertain);
    });

    test('ACK tardio depois do prazo é ignorado', () async {
      final _FakeSocket socket = _FakeSocket();

      final ChatSendResult result = await sendChatMessageWithAck(
        socket,
        equipeId: equipeId,
        texto: 'Bom dia',
        timeout: const Duration(milliseconds: 20),
      );
      socket.lastAck!(<String, dynamic>{'ok': true, 'messageId': 'm1'});

      expect(result.status, ChatSendStatus.uncertain);
    });
  });
}
