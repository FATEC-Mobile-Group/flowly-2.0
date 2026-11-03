import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meu_app/src/core/network/api_client.dart';
import 'package:meu_app/src/services/face_service.dart';

/// Adapter falso: registra as opções efetivas de cada requisição sem acessar a rede.
class _RecordingAdapter implements HttpClientAdapter {
  final List<RequestOptions> requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    return ResponseBody.fromString(
      '{"token":"jwt","user":{"nome":"Teste"},"enrolled":false}',
      200,
      headers: <String, List<String>>{
        Headers.contentTypeHeader: <String>[Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const Duration globalTimeout = Duration(seconds: 12);
  final Dio dio = ApiClient.instance.dio;
  late HttpClientAdapter originalAdapter;
  late _RecordingAdapter adapter;

  setUpAll(() {
    // O interceptor do ApiClient lê o JWT do flutter_secure_storage.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
          (MethodCall call) async => null,
        );
    originalAdapter = dio.httpClientAdapter;
  });

  setUp(() {
    adapter = _RecordingAdapter();
    dio.httpClientAdapter = adapter;
  });

  tearDownAll(() {
    dio.httpClientAdapter = originalAdapter;
  });

  test('timeout facial é maior que o timeout global', () {
    expect(
      FaceService.faceProcessingTimeout,
      greaterThan(dio.options.receiveTimeout!),
    );
    expect(FaceService.faceProcessingTimeout, const Duration(seconds: 90));
  });

  test('timeouts globais do ApiClient continuam em 12 segundos', () {
    expect(dio.options.connectTimeout, globalTimeout);
    expect(dio.options.receiveTimeout, globalTimeout);
  });

  test('requisições faciais com imagem usam o timeout facial', () async {
    final FaceService service = FaceService();

    await service.enrollWithSession(
      faceSessionToken: 'session',
      imageBase64: 'data:image/jpeg;base64,AAAA',
    );
    await service.verifyWithSession(
      faceSessionToken: 'session',
      imageBase64: 'data:image/jpeg;base64,AAAA',
    );
    await service.enrollFromProfile(imageBase64: 'data:image/jpeg;base64,AAAA');

    expect(adapter.requests.map((RequestOptions r) => r.path), <String>[
      '/api/face/enroll',
      '/api/face/verify',
      '/api/face/enroll-profile',
    ]);
    for (final RequestOptions request in adapter.requests) {
      expect(
        request.receiveTimeout,
        FaceService.faceProcessingTimeout,
        reason: request.path,
      );
      expect(request.connectTimeout, globalTimeout, reason: request.path);
    }
  });

  test('requisições faciais sem imagem mantêm o timeout global', () async {
    final FaceService service = FaceService();

    await service.getStatus();
    await service.skipEnrollment(faceSessionToken: 'session');

    expect(adapter.requests.map((RequestOptions r) => r.path), <String>[
      '/api/face/status',
      '/api/face/skip-enrollment',
    ]);
    for (final RequestOptions request in adapter.requests) {
      expect(request.receiveTimeout, globalTimeout, reason: request.path);
    }
  });

  test('requisições comuns mantêm o timeout global', () async {
    await dio.get<Map<String, dynamic>>('/api/tarefas/minhas');

    expect(adapter.requests.single.receiveTimeout, globalTimeout);
    expect(adapter.requests.single.connectTimeout, globalTimeout);
  });
}
