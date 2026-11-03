import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meu_app/src/app/flowly_router.dart';
import 'package:meu_app/src/core/constants/storage_keys.dart';
import 'package:meu_app/src/core/network/api_client.dart';

/// Adapter falso: responde com o status configurado, sem acessar a rede.
class _FakeAdapter implements HttpClientAdapter {
  int statusCode = 200;
  Future<void> Function()? beforeResponse;
  final List<RequestOptions> requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    await beforeResponse?.call();
    final String body = statusCode == 401
        ? '{"success":false,"error":"Token inválido"}'
        : '{"ok":true}';
    return ResponseBody.fromString(
      body,
      statusCode,
      headers: <String, List<String>>{
        Headers.contentTypeHeader: <String>[Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

const String _jwt = 'header.payload.signature';

Map<String, String> _sessionValues() => <String, String>{
  StorageKeys.jwtToken: _jwt,
  StorageKeys.userName: 'Usuário Teste',
  StorageKeys.userEmail: 'usuario@teste.com',
  StorageKeys.userType: 'user',
  StorageKeys.userId: '64b7f0c2a1b2c3d4e5f60718',
  StorageKeys.userPhoto: '',
  'preferencia_nao_relacionada': 'manter',
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const FlutterSecureStorage storage = FlutterSecureStorage();
  final Dio dio = ApiClient.instance.dio;
  late HttpClientAdapter originalAdapter;
  late _FakeAdapter adapter;
  late int notifications;

  void onSessionCleared() => notifications++;

  setUpAll(() {
    originalAdapter = dio.httpClientAdapter;
    ApiClient.sessionCleared.addListener(onSessionCleared);
  });

  setUp(() {
    adapter = _FakeAdapter();
    dio.httpClientAdapter = adapter;
    notifications = 0;
  });

  tearDownAll(() {
    ApiClient.sessionCleared.removeListener(onSessionCleared);
    dio.httpClientAdapter = originalAdapter;
  });

  Future<DioException> expectDioError(Future<Object?> request) async {
    try {
      await request;
    } on DioException catch (error) {
      return error;
    }
    fail('A requisição deveria lançar DioException.');
  }

  group('ApiClient — tratamento global de 401', () {
    test('A — 401 com JWT salvo limpa a sessão e propaga o erro', () async {
      FlutterSecureStorage.setMockInitialValues(_sessionValues());
      adapter.statusCode = 401;

      final DioException error = await expectDioError(
        dio.get<Map<String, dynamic>>('/api/tarefas/minhas'),
      );

      expect(error.response?.statusCode, 401);
      expect(
        adapter.requests.single.headers['Authorization'],
        'Bearer $_jwt',
      );
      for (final String key in <String>[
        StorageKeys.jwtToken,
        StorageKeys.userName,
        StorageKeys.userEmail,
        StorageKeys.userType,
        StorageKeys.userId,
        StorageKeys.userPhoto,
      ]) {
        expect(await storage.read(key: key), isNull, reason: key);
      }
      expect(
        await storage.read(key: 'preferencia_nao_relacionada'),
        'manter',
        reason: 'não deve usar deleteAll',
      );
      expect(notifications, 1);
    });

    test('B — erro 500 mantém a sessão e propaga o erro', () async {
      FlutterSecureStorage.setMockInitialValues(_sessionValues());
      adapter.statusCode = 500;

      final DioException error = await expectDioError(
        dio.get<Map<String, dynamic>>('/api/tarefas/minhas'),
      );

      expect(error.response?.statusCode, 500);
      expect(await storage.read(key: StorageKeys.jwtToken), _jwt);
      expect(await storage.read(key: StorageKeys.userId), isNotNull);
      expect(notifications, 0);
    });

    test('C — 401 sem sessão (login inválido) é apenas um erro comum', () async {
      FlutterSecureStorage.setMockInitialValues(<String, String>{
        'preferencia_nao_relacionada': 'manter',
      });
      adapter.statusCode = 401;

      final DioException error = await expectDioError(
        dio.post<Map<String, dynamic>>(
          '/api/auth/login',
          data: <String, String>{'email': 'a@b.com', 'senha': 'errada'},
        ),
      );

      expect(error.response?.statusCode, 401);
      expect(adapter.requests.single.headers['Authorization'], isNull);
      expect(await storage.read(key: 'preferencia_nao_relacionada'), 'manter');
      expect(notifications, 0);
    });

    test('C — 401 de um JWT antigo não apaga uma sessão nova', () async {
      FlutterSecureStorage.setMockInitialValues(_sessionValues());
      adapter.statusCode = 401;
      // Novo login concluído enquanto a requisição com o JWT antigo estava em voo.
      adapter.beforeResponse = () =>
          storage.write(key: StorageKeys.jwtToken, value: 'novo.jwt.token');

      final DioException error = await expectDioError(
        dio.get<Map<String, dynamic>>('/api/tarefas/minhas'),
      );

      expect(error.response?.statusCode, 401);
      expect(adapter.requests.single.headers['Authorization'], 'Bearer $_jwt');
      expect(await storage.read(key: StorageKeys.jwtToken), 'novo.jwt.token');
      expect(notifications, 0);
    });

    test('D — requisição bem-sucedida mantém a sessão', () async {
      FlutterSecureStorage.setMockInitialValues(_sessionValues());
      adapter.statusCode = 200;

      final Response<Map<String, dynamic>> response = await dio
          .get<Map<String, dynamic>>('/api/tarefas/minhas');

      expect(response.statusCode, 200);
      expect(await storage.read(key: StorageKeys.jwtToken), _jwt);
      expect(notifications, 0);
    });
  });

  group('Router — reação à sessão removida', () {
    test('401 autenticado faz o GoRouter reavaliar o redirect', () async {
      FlutterSecureStorage.setMockInitialValues(_sessionValues());
      adapter.statusCode = 401;
      int routerRefreshes = 0;
      void onRouterRefresh() => routerRefreshes++;
      flowlyRouter.routeInformationProvider.addListener(onRouterRefresh);
      addTearDown(
        () => flowlyRouter.routeInformationProvider.removeListener(
          onRouterRefresh,
        ),
      );

      await expectDioError(dio.get<Map<String, dynamic>>('/api/users/me'));

      expect(await storage.read(key: StorageKeys.jwtToken), isNull);
      expect(routerRefreshes, 1);
    });

    test('erro que não é 401 não reavalia o redirect', () async {
      FlutterSecureStorage.setMockInitialValues(_sessionValues());
      adapter.statusCode = 500;
      int routerRefreshes = 0;
      void onRouterRefresh() => routerRefreshes++;
      flowlyRouter.routeInformationProvider.addListener(onRouterRefresh);
      addTearDown(
        () => flowlyRouter.routeInformationProvider.removeListener(
          onRouterRefresh,
        ),
      );

      await expectDioError(dio.get<Map<String, dynamic>>('/api/users/me'));

      expect(routerRefreshes, 0);
    });
  });
}
