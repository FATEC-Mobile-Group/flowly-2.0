import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meu_app/src/core/constants/storage_keys.dart';
import 'package:meu_app/src/models/chat_message.dart';
import 'package:meu_app/src/screens/teams/team_chat_screen.dart';
import 'package:meu_app/src/services/chat_service.dart';

/// Serviço falso: histórico vazio, sem socket real; cada envio espera o resultado configurado.
class _FakeChatService extends ChatService {
  final List<String> sentTexts = <String>[];
  // Criado no envio, dentro da zona de tempo simulado do teste.
  late Completer<ChatSendResult> nextResult;

  @override
  Future<List<ChatMessage>> carregarHistorico(String equipeId) async =>
      <ChatMessage>[];

  @override
  Future<void> conectar({
    required String equipeId,
    required void Function(ChatMessage message) onMessage,
  }) async {}

  @override
  Future<ChatSendResult> enviarMensagem({
    required String equipeId,
    required String texto,
  }) {
    sentTexts.add(texto);
    nextResult = Completer<ChatSendResult>();
    return nextResult.future;
  }

  @override
  void desconectar() {}
}

void main() {
  late _FakeChatService service;

  setUp(() {
    FlutterSecureStorage.setMockInitialValues(<String, String>{
      StorageKeys.userId: '507f1f77bcf86cd799439011',
    });
    service = _FakeChatService();
  });

  Future<void> openChat(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: TeamChatScreen(
          teamId: '507f1f77bcf86cd799439099',
          teamName: 'Equipe Alfa',
          chatService: service,
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  String fieldText(WidgetTester tester) =>
      tester.widget<TextField>(find.byType(TextField)).controller!.text;

  testWidgets('mensagem bloqueada mantém o texto e mostra o motivo', (
    WidgetTester tester,
  ) async {
    await openChat(tester);
    await tester.enterText(find.byType(TextField), 'texto recusado');
    await tester.tap(find.byIcon(Icons.send_rounded));
    await tester.pump();

    // Enquanto espera o servidor, não há segundo envio.
    expect(find.byIcon(Icons.send_rounded), findsNothing);
    await tester.tap(find.byType(IconButton));
    await tester.pump();
    expect(service.sentTexts, <String>['texto recusado']);

    service.nextResult.complete(
      const ChatSendResult(
        ChatSendStatus.blocked,
        message: 'Parece conter um insulto.',
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(fieldText(tester), 'texto recusado');
    expect(find.text('Parece conter um insulto.'), findsOneWidget);
    expect(find.byIcon(Icons.send_rounded), findsOneWidget);
  });

  testWidgets('envio confirmado limpa o campo', (WidgetTester tester) async {
    await openChat(tester);
    await tester.enterText(find.byType(TextField), 'Bom dia');
    await tester.tap(find.byIcon(Icons.send_rounded));
    await tester.pump();

    service.nextResult.complete(
      const ChatSendResult(ChatSendStatus.sent, messageId: 'm1'),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(fieldText(tester), isEmpty);
  });

  testWidgets('resultado incerto mantém o texto e avisa sem reenviar', (
    WidgetTester tester,
  ) async {
    await openChat(tester);
    await tester.enterText(find.byType(TextField), 'Bom dia');
    await tester.tap(find.byIcon(Icons.send_rounded));
    await tester.pump();

    service.nextResult.complete(ChatSendResult.uncertain);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(fieldText(tester), 'Bom dia');
    expect(find.text(ChatSendResult.uncertainMessage), findsOneWidget);
    expect(service.sentTexts, hasLength(1));
  });
}
