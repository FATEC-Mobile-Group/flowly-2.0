import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meu_app/src/core/constants/storage_keys.dart';
import 'package:meu_app/src/models/chat_message.dart';
import 'package:meu_app/src/screens/teams/team_chat_screen.dart';
import 'package:meu_app/src/services/chat_attachments.dart';
import 'package:meu_app/src/services/chat_service.dart';

const String _me = '507f1f77bcf86cd799439011';
const String _equipe = '507f1f77bcf86cd799439099';
final RegExp _uuidV4 = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

String _path(String id, {bool inline = false}) =>
    '/api/equipes/$_equipe/mensagens/$id/anexo${inline ? '?disposition=inline' : ''}';

ChatMessage _text(
  String id,
  String texto, {
  String user = 'outro',
  String nome = 'Bruno',
  int minute = 0,
}) => ChatMessage(
  id: id,
  texto: texto,
  userId: user,
  userName: nome,
  createdAt: DateTime.utc(2026, 11, 20, 10, minute),
);

ChatMessage _attachment(
  String id, {
  String nome = 'ata.pdf',
  String mimetype = 'application/pdf',
  String texto = '',
  String user = _me,
  int minute = 30,
}) {
  final bool image = mimetype.startsWith('image/');
  return ChatMessage(
    id: id,
    texto: texto,
    userId: user,
    userName: user == _me ? 'Eu' : 'Bruno',
    tipo: 'anexo',
    createdAt: DateTime.utc(2026, 11, 20, 10, minute),
    anexo: ChatAttachment(
      nomeOriginal: nome,
      mimetype: mimetype,
      size: 3 * 1024 * 1024,
      downloadUrl: _path(id),
      previewUrl: image ? _path(id, inline: true) : null,
    ),
  );
}

class _UploadCall {
  _UploadCall(
    this.file,
    this.clientMessageId,
    this.legenda,
    this.onProgress,
    this.cancelToken,
  );

  final PickedChatFile file;
  final String clientMessageId;
  final String legenda;
  final void Function(double?)? onProgress;
  final CancelToken? cancelToken;
  final Completer<ChatAttachmentUploadResult> result =
      Completer<ChatAttachmentUploadResult>();
}

class _FakeChatService extends ChatService {
  List<ChatMessage> history = <ChatMessage>[];
  List<ChatMessage> missing = <ChatMessage>[];
  final List<DateTime> syncedAfter = <DateTime>[];
  final List<String> sentTexts = <String>[];
  final List<_UploadCall> uploads = <_UploadCall>[];
  final List<String> downloads = <String>[];
  Object? downloadError;
  void Function(ChatMessage message)? onMessage;

  void reconnect() => notificarReconexao();

  @override
  Future<List<ChatMessage>> carregarHistorico(String equipeId) async => history;

  @override
  Future<List<ChatMessage>> carregarNovasMensagens(
    String equipeId,
    DateTime after,
  ) async {
    syncedAfter.add(after);
    return missing;
  }

  @override
  Future<void> conectar({
    required String equipeId,
    required void Function(ChatMessage message) onMessage,
  }) async {
    this.onMessage = onMessage;
  }

  @override
  Future<ChatSendResult> enviarMensagem({
    required String equipeId,
    required String texto,
  }) async {
    sentTexts.add(texto);
    return const ChatSendResult(ChatSendStatus.sent, messageId: 'm1');
  }

  @override
  Future<ChatAttachmentUploadResult> enviarAnexo({
    required String equipeId,
    required PickedChatFile file,
    required String clientMessageId,
    String legenda = '',
    void Function(double? progress)? onProgress,
    CancelToken? cancelToken,
  }) {
    final _UploadCall call = _UploadCall(
      file,
      clientMessageId,
      legenda,
      onProgress,
      cancelToken,
    );
    uploads.add(call);
    cancelToken?.whenCancel.then((_) {
      if (!call.result.isCompleted) {
        call.result.completeError(
          describeChatUploadError(
            DioException(
              requestOptions: RequestOptions(path: '/x'),
              type: DioExceptionType.cancel,
            ),
          ),
        );
      }
    });
    return call.result.future;
  }

  @override
  Future<Uint8List> baixarAnexo(String path, {CancelToken? cancelToken}) async {
    downloads.add(path);
    if (downloadError != null) {
      throw downloadError!;
    }
    return Uint8List.fromList(<int>[1, 2, 3]);
  }

  @override
  void desconectar() {}
}

class _FakeFiles extends ChatFileGateway {
  final List<PickedChatFile?> next = <PickedChatFile?>[];
  final List<String> saved = <String>[];
  int clears = 0;

  @override
  Future<PickedChatFile?> pick() async =>
      next.isEmpty ? null : next.removeAt(0);

  @override
  Future<bool> save(String fileName, Uint8List bytes) async {
    saved.add(fileName);
    return true;
  }

  @override
  Future<void> clearTemporary() async => clears++;
}

PickedChatFile _file(String name, {int size = 2048}) => PickedChatFile(
  name: name,
  size: size,
  bytes: Uint8List.fromList(<int>[1, 2, 3]),
);

ChatHttpError _http(int status, String codigo, String erro) =>
    ChatHttpError(status, codigo, erro);

/// Atalho para gerar o aviso do mesmo jeito que o serviço real gera a partir de um DioException.
class ChatHttpError {
  ChatHttpError(this.status, this.codigo, this.erro);
  final int status;
  final String codigo;
  final String erro;

  ChatAttachmentException get notice => describeChatUploadError(
    DioException(
      requestOptions: RequestOptions(path: '/x'),
      response: Response<dynamic>(
        requestOptions: RequestOptions(path: '/x'),
        statusCode: status,
        data: <String, dynamic>{'erro': erro, 'codigo': codigo},
      ),
    ),
  );
}

void main() {
  late _FakeChatService service;
  late _FakeFiles files;

  setUp(() {
    FlutterSecureStorage.setMockInitialValues(<String, String>{
      StorageKeys.userId: _me,
    });
    service = _FakeChatService()
      ..history = <ChatMessage>[_text('t1', 'Mensagem antiga')];
    files = _FakeFiles();
  });

  Future<void> openChat(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: TeamChatScreen(
          teamId: _equipe,
          teamName: 'Equipe Alfa',
          chatService: service,
          fileGateway: files,
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  String fieldText(WidgetTester tester) =>
      tester.widget<TextField>(find.byType(TextField)).controller!.text;

  Future<void> choose(WidgetTester tester, PickedChatFile file) async {
    files.next.add(file);
    await tester.tap(
      find.byTooltip('Anexar arquivo (PNG, JPG ou PDF, até 10 MB)'),
    );
    await tester.pumpAndSettle();
  }

  Future<void> send(WidgetTester tester) async {
    await tester.tap(find.byIcon(Icons.send_rounded));
    await tester.pump();
  }

  // Nova tentativa pela ação do aviso (o aviso flutuante cobre o composer).
  Future<void> retry(WidgetTester tester) async {
    await tester.tap(find.text('Tentar de novo'));
    await tester.pump();
  }

  // A pessoa dispensa o aviso (deslizar) para voltar a usar o composer.
  Future<void> dismissNotice(WidgetTester tester) async {
    ScaffoldMessenger.of(
      tester.element(find.byType(TeamChatScreen)),
    ).removeCurrentSnackBar();
    await tester.pump();
  }

  Future<void> settleNotice(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  testWidgets('histórico: texto antigo, imagem com legenda e PDF sem legenda', (
    WidgetTester tester,
  ) async {
    service.history = <ChatMessage>[
      _text('t1', 'Mensagem antiga'),
      _attachment(
        'i1',
        nome: 'tela.png',
        mimetype: 'image/png',
        texto: 'print',
        user: 'outro',
        minute: 10,
      ),
      _attachment('p1', minute: 20),
    ];
    await openChat(tester);

    expect(find.text('Mensagem antiga'), findsOneWidget);
    expect(find.text('print'), findsOneWidget);
    expect(find.text('tela.png'), findsOneWidget);
    expect(find.text('ata.pdf'), findsOneWidget);
    expect(find.text('3,0 MB'), findsNWidgets(2));
    expect(find.byTooltip('Baixar ata.pdf'), findsOneWidget);
    // Só a imagem é buscada (autenticada, pelo serviço); o PDF não é carregado no app.
    expect(service.downloads, <String>[_path('i1', inline: true)]);
  });

  testWidgets('ampliar a imagem e fechar', (WidgetTester tester) async {
    service.history = <ChatMessage>[
      _attachment('i1', nome: 'tela.png', mimetype: 'image/png', user: 'outro'),
    ];
    await openChat(tester);

    await tester.tap(
      find.byWidgetPredicate(
        (Widget w) =>
            w is Semantics && w.properties.label == 'Ampliar imagem tela.png',
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byTooltip('Fechar imagem'), findsOneWidget);
    await tester.tap(find.byTooltip('Fechar imagem'));
    await tester.pumpAndSettle();
    expect(find.byTooltip('Fechar imagem'), findsNothing);
  });

  testWidgets(
    'seleção de imagem e PDF mostra a pré-visualização; remover limpa e mantém o texto',
    (WidgetTester tester) async {
      await openChat(tester);
      await tester.enterText(find.byType(TextField), 'texto em andamento');

      await choose(tester, _file('foto.jpg'));
      expect(find.text('foto.jpg'), findsOneWidget);
      expect(find.text('2 KB'), findsOneWidget);
      expect(find.byTooltip('Remover arquivo'), findsOneWidget);
      expect(service.uploads, isEmpty);

      await choose(tester, _file('ata.pdf'));
      expect(find.text('foto.jpg'), findsNothing);
      expect(find.text('ata.pdf'), findsOneWidget);
      expect(find.byIcon(Icons.picture_as_pdf_outlined), findsOneWidget);

      await tester.tap(find.byTooltip('Remover arquivo'));
      await tester.pumpAndSettle();
      expect(find.text('ata.pdf'), findsNothing);
      expect(fieldText(tester), 'texto em andamento');
      expect(files.clears, 1);
    },
  );

  testWidgets('cancelar o seletor não muda nada', (WidgetTester tester) async {
    await openChat(tester);
    await tester.enterText(find.byType(TextField), 'oi');
    await choose(tester, _file('ata.pdf'));
    await tester.tap(find.byTooltip('Trocar arquivo'));
    await tester.pumpAndSettle();

    expect(find.text('ata.pdf'), findsOneWidget);
    expect(fieldText(tester), 'oi');
  });

  for (final (String caso, PickedChatFile file, String titulo)
      in <(String, PickedChatFile, String)>[
        (
          'formato não suportado',
          _file('anim.gif'),
          'Tipo de arquivo não permitido',
        ),
        (
          'acima de 10 MB',
          _file('grande.pdf', size: kChatAttachmentMaxBytes + 1),
          'Arquivo muito grande',
        ),
      ]) {
    testWidgets('$caso é recusado antes do envio', (WidgetTester tester) async {
      await openChat(tester);
      await choose(tester, file);
      await settleNotice(tester);

      expect(find.text(titulo), findsOneWidget);
      expect(find.byTooltip('Remover arquivo'), findsNothing);
      expect(service.uploads, isEmpty);
    });
  }

  testWidgets(
    'envio com legenda: UUID, progresso, mensagem exibida, rascunho limpo; socket repetido não duplica',
    (WidgetTester tester) async {
      await openChat(tester);
      await choose(tester, _file('foto.png'));
      await tester.enterText(find.byType(TextField), '  olha isso  ');
      await send(tester);

      final _UploadCall call = service.uploads.single;
      expect(call.legenda, 'olha isso');
      expect(call.clientMessageId, matches(_uuidV4));
      expect(call.file.name, 'foto.png');

      call.onProgress!(0.4);
      await tester.pump();
      expect(find.text('40%'), findsOneWidget);
      expect(find.text('Cancelar'), findsOneWidget);

      final ChatMessage message = _attachment(
        'n1',
        nome: 'foto.png',
        mimetype: 'image/png',
        texto: 'olha isso',
        minute: 50,
      );
      // O evento do socket do próprio envio chega antes da resposta HTTP.
      service.onMessage!(message);
      call.result.complete(ChatAttachmentUploadResult(message));
      await tester.pumpAndSettle();
      service.onMessage!(message);
      await tester.pumpAndSettle();

      expect(find.text('olha isso'), findsOneWidget);
      expect(find.byTooltip('Remover arquivo'), findsNothing);
      expect(fieldText(tester), isEmpty);
      expect(files.clears, 1);
    },
  );

  testWidgets('envio sem legenda e repetição reconhecida (200) sem duplicar', (
    WidgetTester tester,
  ) async {
    final ChatMessage existing = _attachment('p9', minute: 40);
    service.history = <ChatMessage>[_text('t1', 'Mensagem antiga'), existing];
    await openChat(tester);
    await choose(tester, _file('ata.pdf'));
    await send(tester);

    expect(service.uploads.single.legenda, isEmpty);
    service.uploads.single.result.complete(
      ChatAttachmentUploadResult(existing, duplicate: true),
    );
    await tester.pumpAndSettle();

    expect(find.byTooltip('Baixar ata.pdf'), findsOneWidget);
  });

  testWidgets(
    '503 mantém arquivo e legenda; nova tentativa usa o mesmo id; legenda alterada gera outro',
    (WidgetTester tester) async {
      await openChat(tester);
      await choose(tester, _file('ata.pdf'));
      await tester.enterText(find.byType(TextField), 'v1');

      await send(tester);
      service.uploads[0].result.completeError(
        _http(503, 'moderation_unavailable', 'x').notice,
      );
      await settleNotice(tester);
      expect(find.text('Verificação indisponível'), findsOneWidget);
      expect(find.text('ata.pdf'), findsOneWidget);
      expect(fieldText(tester), 'v1');

      await retry(tester);
      service.uploads[1].result.completeError(
        _http(503, 'storage_unavailable', 'x').notice,
      );
      await settleNotice(tester);
      expect(
        service.uploads[1].clientMessageId,
        service.uploads[0].clientMessageId,
      );

      await dismissNotice(tester);
      await tester.enterText(find.byType(TextField), 'v2');
      await send(tester);
      expect(
        service.uploads[2].clientMessageId,
        isNot(service.uploads[0].clientMessageId),
      );
      service.uploads[2].result.completeError(
        _http(503, 'storage_unavailable', 'x').notice,
      );
      await settleNotice(tester);
    },
  );

  testWidgets('trocar o arquivo depois de uma falha gera outro id', (
    WidgetTester tester,
  ) async {
    await openChat(tester);
    await choose(tester, _file('a.pdf'));
    await send(tester);
    service.uploads[0].result.completeError(
      describeChatUploadError(Exception('rede')),
    );
    await settleNotice(tester);
    expect(find.text('Falha de conexão'), findsOneWidget);

    await dismissNotice(tester);
    await choose(tester, _file('b.pdf'));
    await send(tester);
    expect(
      service.uploads[1].clientMessageId,
      isNot(service.uploads[0].clientMessageId),
    );
    service.uploads[1].result.completeError(
      describeChatUploadError(Exception('rede')),
    );
    await settleNotice(tester);
  });

  testWidgets('409 avisa e a próxima tentativa usa um id novo', (
    WidgetTester tester,
  ) async {
    await openChat(tester);
    await choose(tester, _file('ata.pdf'));
    await send(tester);
    service.uploads[0].result.completeError(
      _http(409, 'client_message_id_conflict', 'x').notice,
    );
    await settleNotice(tester);
    expect(find.text('Envio em conflito'), findsOneWidget);

    await retry(tester);
    expect(
      service.uploads[1].clientMessageId,
      isNot(service.uploads[0].clientMessageId),
    );
    service.uploads[1].result.completeError(
      _http(409, 'client_message_id_conflict', 'x').notice,
    );
    await settleNotice(tester);
  });

  testWidgets('422 da legenda mostra o motivo e mantém os dados', (
    WidgetTester tester,
  ) async {
    await openChat(tester);
    await choose(tester, _file('ata.pdf'));
    await tester.enterText(find.byType(TextField), 'legenda ruim');
    await send(tester);
    service.uploads[0].result.completeError(
      _http(
        422,
        'caption_blocked',
        'A legenda não foi aceita porque parece conter um insulto.',
      ).notice,
    );
    await settleNotice(tester);

    expect(find.text('Legenda não aceita'), findsOneWidget);
    expect(
      find.text('A legenda não foi aceita porque parece conter um insulto.'),
      findsOneWidget,
    );
    expect(fieldText(tester), 'legenda ruim');
    expect(find.text('ata.pdf'), findsOneWidget);
    // Recusa de conteúdo pede correção, não repetição.
    expect(find.text('Tentar de novo'), findsNothing);
  });

  testWidgets(
    'cancelar interrompe, mantém arquivo e legenda; repetir usa o mesmo id',
    (WidgetTester tester) async {
      await openChat(tester);
      await choose(tester, _file('ata.pdf'));
      await tester.enterText(find.byType(TextField), 'legenda');
      await send(tester);

      await tester.tap(find.text('Cancelar'));
      await settleNotice(tester);
      expect(service.uploads[0].cancelToken!.isCancelled, isTrue);
      expect(find.text('Envio cancelado'), findsOneWidget);
      expect(find.text('ata.pdf'), findsOneWidget);
      expect(fieldText(tester), 'legenda');

      await retry(tester);
      expect(
        service.uploads[1].clientMessageId,
        service.uploads[0].clientMessageId,
      );
      service.uploads[1].result.complete(
        ChatAttachmentUploadResult(_attachment('c1', texto: 'legenda')),
      );
      await tester.pumpAndSettle();
      expect(find.byTooltip('Baixar ata.pdf'), findsOneWidget);
    },
  );

  testWidgets('download autenticado salva com o nome original', (
    WidgetTester tester,
  ) async {
    service.history = <ChatMessage>[_attachment('p1', nome: 'ata final.pdf')];
    await openChat(tester);

    await tester.tap(find.byTooltip('Baixar ata final.pdf'));
    await settleNotice(tester);

    expect(service.downloads, <String>[_path('p1')]);
    expect(files.saved, <String>['ata final.pdf']);
    expect(find.text('Arquivo salvo.'), findsOneWidget);
  });

  testWidgets('falha no download mostra aviso sem expor detalhes', (
    WidgetTester tester,
  ) async {
    service.history = <ChatMessage>[_attachment('p1')];
    service.downloadError = describeChatDownloadError(
      DioException(
        requestOptions: RequestOptions(path: _path('p1')),
        response: Response<dynamic>(
          requestOptions: RequestOptions(path: '/x'),
          statusCode: 404,
        ),
      ),
    );
    await openChat(tester);

    await tester.tap(find.byTooltip('Baixar ata.pdf'));
    await settleNotice(tester);

    expect(find.text('Este anexo não está mais disponível.'), findsOneWidget);
    expect(find.textContaining('/api/'), findsNothing);
    expect(files.saved, isEmpty);
  });

  testWidgets(
    'mensagem de outra pessoa pelo socket aparece uma vez; reconexão sincroniza com after',
    (WidgetTester tester) async {
      await openChat(tester);
      final ChatMessage nova = _attachment(
        's1',
        nome: 'recebida.pdf',
        user: 'outro',
        minute: 45,
      );
      service.onMessage!(nova);
      service.onMessage!(nova);
      await tester.pumpAndSettle();
      expect(find.text('recebida.pdf'), findsOneWidget);

      service.missing = <ChatMessage>[
        nova,
        _text('s2', 'chegou na queda', minute: 50),
      ];
      service.reconnect();
      await tester.pumpAndSettle();

      expect(service.syncedAfter.single, DateTime.utc(2026, 11, 20, 10, 45));
      expect(find.text('chegou na queda'), findsOneWidget);
      expect(find.text('recebida.pdf'), findsOneWidget);
    },
  );

  testWidgets('sem anexo, o envio continua sendo texto pelo socket', (
    WidgetTester tester,
  ) async {
    await openChat(tester);
    await tester.enterText(find.byType(TextField), 'Bom dia');
    await send(tester);
    await tester.pumpAndSettle();

    expect(service.sentTexts, <String>['Bom dia']);
    expect(service.uploads, isEmpty);
    expect(fieldText(tester), isEmpty);
  });
}
