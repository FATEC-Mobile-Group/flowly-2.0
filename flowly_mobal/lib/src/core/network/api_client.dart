import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:meu_app/src/core/config/api_config.dart';
import 'package:meu_app/src/core/constants/storage_keys.dart';
import 'package:meu_app/src/core/network/api_exception.dart';
import 'package:meu_app/src/services/auth_service.dart';

class ApiClient {
  ApiClient._() {
    _dio = Dio(
      BaseOptions(
        baseUrl: ApiConfig.baseUrl,
        connectTimeout: const Duration(seconds: 12),
        receiveTimeout: const Duration(seconds: 12),
      ),
    );

    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest:
            (RequestOptions options, RequestInterceptorHandler handler) async {
              final String? token = await _storage.read(
                key: StorageKeys.jwtToken,
              );
              if (token != null && token.isNotEmpty) {
                options.headers['Authorization'] = 'Bearer $token';
              }
              handler.next(options);
            },
        onError: (DioException error, ErrorInterceptorHandler handler) async {
          if (error.response?.statusCode == 401) {
            try {
              await _clearExpiredSession(error.requestOptions);
            } catch (_) {
              // A limpeza é best-effort; o erro original continua sendo propagado.
            }
          }
          handler.next(error);
        },
      ),
    );
  }

  static final ApiClient instance = ApiClient._();

  /// Notificado quando a sessão local é removida após um 401 (o GoRouter reavalia o redirect).
  static final ValueNotifier<int> sessionCleared = ValueNotifier<int>(0);

  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  late final Dio _dio;

  Dio get dio => _dio;

  /// Só trata como sessão expirada o 401 de uma requisição que enviou o JWT
  /// ainda salvo; 401 de login/2FA/face pré-login (sem JWT) segue como erro comum.
  Future<void> _clearExpiredSession(RequestOptions options) async {
    final Object? authorization = options.headers['Authorization'];
    if (authorization is! String || !authorization.startsWith('Bearer ')) {
      return;
    }

    final String? storedToken = await _storage.read(key: StorageKeys.jwtToken);
    if (storedToken == null || 'Bearer $storedToken' != authorization) {
      return;
    }

    await AuthService(storage: _storage).logout();
    sessionCleared.value++;
  }

  static ApiException mapError(Object error) {
    if (error is DioException) {
      final Object? data = error.response?.data;
      if (data is Map<String, dynamic>) {
        final String? erro = data['erro']?.toString();
        final String? errorMsg = data['error']?.toString();
        final String? detalhe = data['detalhe']?.toString();
        final String? mensagem = data['mensagem']?.toString();
        final String? message = data['message']?.toString();
        return ApiException(
          erro ??
              errorMsg ??
              detalhe ??
              mensagem ??
              message ??
              'Erro de requisição.',
        );
      }
      if (data is String && data.trim().isNotEmpty) {
        return ApiException(data);
      }
      return ApiException('Falha de conexão com a API.');
    }
    return ApiException('Erro inesperado.');
  }
}
