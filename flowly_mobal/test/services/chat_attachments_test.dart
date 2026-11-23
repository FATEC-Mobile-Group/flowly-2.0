import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meu_app/src/core/constants/storage_keys.dart';
import 'package:meu_app/src/core/network/api_client.dart';
import 'package:meu_app/src/models/chat_message.dart';
import 'package:meu_app/src/services/chat_attachments.dart';
import 'package:meu_app/src/services/chat_service.dart';

/// Adapter falso: responde o que o teste configurar, sem rede. Consome o corpo (dispara o progresso).
class _FakeAdapter implements HttpClientAdapter {
  final List<RequestOptions> requests = <RequestOptions>[];
  int status = 201;
  Object? body;
  Uint8List? bytes;
  bool hang = false;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    await requestStream?.drain<void>();
    if (hang) {
      await (cancelFuture ?? Completer<void>().future);
    }
    if (bytes != null) {
      return ResponseBody.fromBytes(bytes!, status);
    }
    return ResponseBody.fromString(
      jsonEncode(body ?? <String, dynamic>{}),
      status,
      headers: <String, List<String>>{
        Headers.contentTypeHeader: <String>[Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

const String _equipe = '507f1f77bcf86cd799439099';
const String _messageId = '507f1f77bcf86cd799439088';
const String _download = '/api/equipes/$_equipe/mensagens/$_messageId/anexo';
final RegExp _uuidV4 = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

Map<String, dynamic> _serverMessage({String texto = ''}) => <String, dynamic>{
  '_id': _messageId,
  'tipo': 'anexo',
  'texto': texto,
  'createdAt': '2026-11-23T12:00:00.000Z',
  'user': <String, dynamic>{'_id': 'u1', 'nome': 'Ana'},
  'clientMessageId': '0f8fad5b-d9cb-469f-a165-70867728950e',
  'anexo': <String, dynamic>{
    'nomeOriginal': 'foto.png',
    'mimetype': 'image/png',
    'size': 2048,
    'downloadUrl': _download,
    'previewUrl': '$_download?disposition=inline',
  },
};

PickedChatFile _png({String name = 'foto.png', int size = 4}) => PickedChatFile(
  name: name,
  size: size,
  bytes: Uint8List.fromList(<int>[1, 2, 3, 4]),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('modelo e utilitários', () {
    test('mensagem antiga sem tipo continua texto; anexo é reconhecido', () {
      final ChatMessage antiga = ChatMessage.fromJson(<String, dynamic>{
        '_id': 'a1',
        'texto': 'oi',
        'user': <String, dynamic>{'_id': 'u1', 'nome': 'Ana'},
      });
      expect(antiga.isAttachment, isFalse);
      expect(antiga.tipo, 'texto');

      final ChatMessage anexo = ChatMessage.fromJson(
        _serverMessage(texto: 'legenda'),
      );
      expect(anexo.isAttachment, isTrue);
      expect(anexo.anexo!.isImage, isTrue);
      expect(anexo.anexo!.previewUrl, endsWith('?disposition=inline'));
      expect(anexo.texto, 'legenda');

      // tipo anexo sem bloco anexo válido não quebra a tela: vira texto.
      expect(
        ChatMessage.fromJson(<String, dynamic>{
          '_id': 'x',
          'tipo': 'anexo',
        }).isAttachment,
        isFalse,
      );
    });

    test(
      'mergeChatMessages não duplica por _id e mantém a ordem cronológica',
      () {
        ChatMessage m(String id, String at, [String texto = '']) => ChatMessage(
          id: id,
          texto: texto,
          userId: 'u',
          userName: 'U',
          createdAt: DateTime.parse(at),
        );
        final ChatMessage a = m('1', '2026-11-20T10:00:00Z');
        final ChatMessage b = m('2', '2026-11-20T11:00:00Z', 'b');
        final List<ChatMessage> merged = mergeChatMessages(
          <ChatMessage>[b],
          <ChatMessage>[a, b, m('2', '2026-11-20T11:00:00Z', 'b2')],
        );
        expect(merged.map((ChatMessage x) => x.id), <String>['1', '2']);
        expect(merged.last.texto, 'b2');
      },
    );

    test('validação: tipo, tamanho e arquivo vazio', () {
      expect(validateChatFile(_png()), isNull);
      expect(validateChatFile(_png(name: 'ata.PDF')), isNull);
      expect(
        validateChatFile(_png(name: 'anim.gif'))!.title,
        'Tipo de arquivo não permitido',
      );
      expect(
        validateChatFile(_png(name: 'doc.docx'))!.title,
        'Tipo de arquivo não permitido',
      );
      expect(
        validateChatFile(_png(size: kChatAttachmentMaxBytes + 1))!.title,
        'Arquivo muito grande',
      );
      expect(validateChatFile(_png(size: 0))!.title, 'Arquivo vazio');
      expect(chatMimeTypeFor('x.JPG'), 'image/jpeg');
    });

    test('clientMessageId é UUID v4 minúsculo e único', () {
      final String a = newClientMessageId();
      expect(a, matches(_uuidV4));
      expect(newClientMessageId(), isNot(a));
    });

    test('nome seguro para salvar e caminhos aceitos', () {
      expect(safeDownloadName('..\\pasta/re:la*tó?rio.pdf'), 'relatório.pdf');
      expect(safeDownloadName(''), 'arquivo');
      expect(isValidAttachmentPath(_download), isTrue);
      expect(isValidAttachmentPath('$_download?disposition=inline'), isTrue);
      expect(isValidAttachmentPath('https://outro.site/x.png'), isFalse);
      expect(isValidAttachmentPath('/api/storage/files/x?token=abc'), isFalse);
    });

    test('erros do servidor 5xx nunca aparecem para a pessoa', () {
      final DioException error = DioException(
        requestOptions: RequestOptions(path: '/x'),
        response: Response<dynamic>(
          requestOptions: RequestOptions(path: '/x'),
          statusCode: 500,
          data: <String, dynamic>{'erro': 'MongoServerError: stack interna'},
        ),
      );
      final ChatAttachmentException notice = describeChatUploadError(error);
      expect(notice.message, isNot(contains('Mongo')));
      expect(notice.title, 'Falha no envio');
    });
  });

  group('ChatService com a API simulada', () {
    final Dio dio = ApiClient.instance.dio;
    late HttpClientAdapter original;
    late _FakeAdapter adapter;
    final ChatService service = ChatService();

    setUpAll(() => original = dio.httpClientAdapter);
    tearDownAll(() => dio.httpClientAdapter = original);

    setUp(() {
      FlutterSecureStorage.setMockInitialValues(<String, String>{
        StorageKeys.jwtToken: 'jwt-de-teste',
      });
      adapter = _FakeAdapter();
      dio.httpClientAdapter = adapter;
    });

    test(
      'multipart correto: campos, tipo declarado do arquivo, JWT no cabeçalho e progresso',
      () async {
        adapter.body = <String, dynamic>{
          'ok': true,
          'duplicate': false,
          'message': _serverMessage(texto: 'olha'),
        };
        final List<double?> progress = <double?>[];
        final ChatAttachmentUploadResult result = await service.enviarAnexo(
          equipeId: _equipe,
          file: _png(),
          clientMessageId: '0f8fad5b-d9cb-469f-a165-70867728950e',
          legenda: 'olha',
          onProgress: progress.add,
        );

        final RequestOptions request = adapter.requests.single;
        expect(request.method, 'POST');
        expect(request.path, '/api/equipes/$_equipe/mensagens/anexos');
        expect(request.headers['Authorization'], 'Bearer jwt-de-teste');
        expect(request.uri.toString(), isNot(contains('jwt')));
        final FormData form = request.data as FormData;
        expect(Map<String, String>.fromEntries(form.fields), <String, String>{
          'clientMessageId': '0f8fad5b-d9cb-469f-a165-70867728950e',
          'legenda': 'olha',
        });
        final MultipartFile file = form.files.single.value;
        expect(form.files.single.key, 'file');
        expect(file.filename, 'foto.png');
        expect(file.contentType.toString(), 'image/png');
        expect(progress, isNotEmpty);
        expect(progress.last, 1);
        expect(result.duplicate, isFalse);
        expect(result.message.isAttachment, isTrue);
        expect(result.message.texto, 'olha');
      },
    );

    test('sem legenda o campo não vai; 200 é repetição reconhecida', () async {
      adapter
        ..status = 200
        ..body = <String, dynamic>{
          'ok': true,
          'duplicate': true,
          'message': _serverMessage(),
        };
      final ChatAttachmentUploadResult result = await service.enviarAnexo(
        equipeId: _equipe,
        file: _png(name: 'ata.pdf'),
        clientMessageId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      );
      final FormData form = adapter.requests.single.data as FormData;
      expect(form.fields.map((MapEntry<String, String> e) => e.key), <String>[
        'clientMessageId',
      ]);
      expect(form.files.single.value.contentType.toString(), 'application/pdf');
      expect(result.duplicate, isTrue);
    });

    for (final (int status, String codigo, String titulo)
        in <(int, String, String)>[
          (409, 'client_message_id_conflict', 'Envio em conflito'),
          (422, 'caption_blocked', 'Legenda não aceita'),
          (422, 'upload_blocked', 'Arquivo bloqueado'),
          (503, 'moderation_unavailable', 'Verificação indisponível'),
          (503, 'storage_unavailable', 'Serviço indisponível'),
          (413, '', 'Arquivo muito grande'),
          (404, '', 'Chat indisponível'),
          (400, 'invalid_multipart', 'Arquivo não aceito'),
        ]) {
      test('HTTP $status $codigo vira "$titulo"', () async {
        adapter
          ..status = status
          ..body = <String, dynamic>{
            'erro': 'Mensagem do servidor.',
            'codigo': codigo,
          };
        await expectLater(
          service.enviarAnexo(
            equipeId: _equipe,
            file: _png(),
            clientMessageId: newClientMessageId(),
          ),
          throwsA(
            isA<ChatAttachmentException>().having(
              (ChatAttachmentException e) => e.title,
              'title',
              titulo,
            ),
          ),
        );
      });
    }

    test('cancelamento vira aviso de envio cancelado', () async {
      adapter.hang = true;
      final CancelToken token = CancelToken();
      final Future<ChatAttachmentUploadResult> pending = service.enviarAnexo(
        equipeId: _equipe,
        file: _png(),
        clientMessageId: newClientMessageId(),
        cancelToken: token,
      );
      await Future<void>.delayed(const Duration(milliseconds: 20));
      token.cancel();
      await expectLater(
        pending,
        throwsA(
          isA<ChatAttachmentException>().having(
            (ChatAttachmentException e) => e.canceled,
            'canceled',
            isTrue,
          ),
        ),
      );
    });

    test(
      'download autenticado em bytes; caminho inválido nem faz requisição',
      () async {
        adapter
          ..status = 200
          ..bytes = Uint8List.fromList(<int>[37, 80, 68, 70]);
        final Uint8List bytes = await service.baixarAnexo(_download);
        expect(bytes, <int>[37, 80, 68, 70]);
        expect(
          adapter.requests.single.headers['Authorization'],
          'Bearer jwt-de-teste',
        );
        expect(adapter.requests.single.responseType, ResponseType.bytes);

        await expectLater(
          service.baixarAnexo('https://outro.site/x.png'),
          throwsA(isA<ChatAttachmentException>()),
        );
        expect(adapter.requests, hasLength(1));
      },
    );

    test('falha de download não expõe URL nem detalhes', () async {
      adapter
        ..status = 404
        ..bytes = Uint8List.fromList(
          utf8.encode('{"erro":"gs://bucket/chat/segredo.pdf"}'),
        );
      try {
        await service.baixarAnexo(_download);
        fail('deveria falhar');
      } on ChatAttachmentException catch (error) {
        expect(error.message, 'Este anexo não está mais disponível.');
        expect(error.toString(), isNot(contains('gs://')));
        expect(error.toString(), isNot(contains(_download)));
      }
    });

    test('sincronização da reconexão usa ?after= em UTC', () async {
      adapter
        ..status = 200
        ..body = <dynamic>[];
      await service.carregarNovasMensagens(
        _equipe,
        DateTime.utc(2026, 11, 23, 12),
      );
      expect(adapter.requests.single.queryParameters, <String, dynamic>{
        'after': '2026-11-23T12:00:00.000Z',
      });
    });
  });
}
