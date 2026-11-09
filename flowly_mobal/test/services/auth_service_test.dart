import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:meu_app/src/core/network/api_client.dart';
import 'package:meu_app/src/models/auth_result.dart';
import 'package:meu_app/src/services/auth_service.dart';

/// Adapter falso: devolve a resposta de login configurada, sem acessar a rede.
class _LoginAdapter implements HttpClientAdapter {
  _LoginAdapter(this.body);

  final Map<String, dynamic> body;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    return ResponseBody.fromString(
      jsonEncode(body),
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

  const String adminOnlyMessage =
      'Administradores estão disponíveis apenas no desktop.';
  final Dio dio = ApiClient.instance.dio;
  late HttpClientAdapter originalAdapter;
  late List<MethodCall> storageCalls;

  setUpAll(() {
    originalAdapter = dio.httpClientAdapter;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
          (MethodCall call) async {
            storageCalls.add(call);
            return null;
          },
        );
  });

  setUp(() {
    storageCalls = <MethodCall>[];
  });

  tearDownAll(() {
    dio.httpClientAdapter = originalAdapter;
  });

  Future<AuthResult> loginWith(Map<String, dynamic> body) {
    dio.httpClientAdapter = _LoginAdapter(body);
    return AuthService().login(email: 'conta@exemplo.com', senha: 'Senha@123');
  }

  bool storedSomething() =>
      storageCalls.any((MethodCall call) => call.method == 'write');

  test('admin com rosto é barrado antes da etapa facial', () async {
    final AuthResult result = await loginWith(<String, dynamic>{
      'requiresFaceVerification': true,
      'faceSessionToken': 'sessao-facial',
      'user': <String, dynamic>{'id': '1', 'nome': 'Admin', 'tipo': 'admin'},
    });

    expect(result.success, isFalse);
    expect(result.message, adminOnlyMessage);
    expect(result.requiresFaceVerification, isFalse);
    expect(result.faceSessionToken, isNull);
    expect(storedSomething(), isFalse);
  });

  test('admin sem rosto continua barrado depois do JWT', () async {
    final AuthResult result = await loginWith(<String, dynamic>{
      'token': 'jwt',
      'user': <String, dynamic>{'id': '1', 'nome': 'Admin', 'tipo': 'admin'},
    });

    expect(result.success, isFalse);
    expect(result.message, adminOnlyMessage);
    expect(storedSomething(), isFalse);
  });

  test('usuário comum com rosto segue para a etapa facial', () async {
    final AuthResult result = await loginWith(<String, dynamic>{
      'requiresFaceVerification': true,
      'faceSessionToken': 'sessao-facial',
      'user': <String, dynamic>{'id': '2', 'nome': 'Pessoa', 'tipo': 'user'},
    });

    expect(result.requiresFaceVerification, isTrue);
    expect(result.faceSessionToken, 'sessao-facial');
    expect(result.userType, 'user');
    expect(storedSomething(), isFalse);
  });

  test('usuário comum sem rosto continua entrando com o JWT', () async {
    final AuthResult result = await loginWith(<String, dynamic>{
      'token': 'jwt',
      'user': <String, dynamic>{'id': '2', 'nome': 'Pessoa', 'tipo': 'user'},
    });

    expect(result.success, isTrue);
    expect(result.token, 'jwt');
    expect(storedSomething(), isTrue);
  });
}
