import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:meu_app/src/core/constants/storage_keys.dart';
import 'package:meu_app/src/core/network/api_client.dart';
import 'package:meu_app/src/models/auth_result.dart';

class AuthService {
  AuthService({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  Future<AuthResult> login({
    required String email,
    required String senha,
  }) async {
    try {
      final response = await ApiClient.instance.dio.post<Map<String, dynamic>>(
        '/api/auth/login',
        data: <String, String>{'email': email, 'senha': senha},
      );

      final Map<String, dynamic> data = response.data ?? <String, dynamic>{};

      if (data['requiresFaceVerification'] == true) {
        final Map<String, dynamic> user = _extractUserMap(data);
        return AuthResult(
          success: false,
          message: 'Verificação facial necessária.',
          requiresFaceVerification: true,
          faceSessionToken: (data['faceSessionToken'] ?? '').toString(),
          name: _extractName(data, user),
          userType: _extractUserType(data, user, ''),
        );
      }

      if (data['requiresFaceEnrollmentOffer'] == true) {
        final Map<String, dynamic> user = _extractUserMap(data);
        return AuthResult(
          success: false,
          message: 'Cadastro facial opcional disponível.',
          requiresFaceEnrollmentOffer: true,
          faceSessionToken: (data['faceSessionToken'] ?? '').toString(),
          name: _extractName(data, user),
          userType: _extractUserType(data, user, ''),
        );
      }

      final String token = (data['token'] ?? '').toString();
      final Map<String, dynamic> user = _extractUserMap(data);
      final String name = _extractName(data, user);
      final String userType = _extractUserType(data, user, token);
      final String userId = (user['id'] ?? user['_id'] ?? '').toString();
      final String fotoPerfil = (user['fotoPerfil'] ?? '').toString();

      if (token.isEmpty) {
        return const AuthResult(
          success: false,
          message: 'Token não retornado no login.',
        );
      }

      if (userType == 'admin') {
        await logout();
        return const AuthResult(
          success: false,
          message: 'Administradores estão disponíveis apenas no desktop.',
        );
      }

      await _storage.write(key: StorageKeys.jwtToken, value: token);
      await _storage.write(key: StorageKeys.userEmail, value: email);
      await _storage.write(key: StorageKeys.userType, value: userType);
      if (userId.isNotEmpty) {
        await _storage.write(key: StorageKeys.userId, value: userId);
      }
      if (name.isNotEmpty) {
        await _storage.write(key: StorageKeys.userName, value: name);
      }
      await _storage.write(key: StorageKeys.userPhoto, value: fotoPerfil);

      return AuthResult(
        success: true,
        message: name.isEmpty
            ? 'Login realizado com sucesso!'
            : 'Bem-vindo $name!',
        token: token,
        name: name,
        userType: userType,
      );
    } catch (error) {
      final String message = ApiClient.mapError(error).message;
      final bool requiresVerification = _messageIndicatesVerification(message);
      return AuthResult(
        success: false,
        message: message,
        requiresVerification: requiresVerification,
      );
    }
  }

  Future<AuthResult> register({
    required String nome,
    required String email,
    required String senha,
    required bool termsAccepted,
  }) async {
    try {
      final response = await ApiClient.instance.dio.post<Map<String, dynamic>>(
        '/api/auth/registrar',
        data: <String, dynamic>{
          'nome': nome,
          'email': email,
          'senha': senha,
          'termsAccepted': termsAccepted,
          'termsVersion': '2026-06-08',
        },
      );

      final Map<String, dynamic> data = response.data ?? <String, dynamic>{};
      final String message =
          (data['msg'] ??
                  data['mensagem'] ??
                  data['message'] ??
                  'Usuário registrado com sucesso!')
              .toString();
      final bool requiresVerification = _extractRequiresVerification(
        data,
        fallbackMessage: message,
      );

      await _storage.write(key: StorageKeys.userEmail, value: email);
      return AuthResult(
        success: true,
        message: message,
        requiresVerification: requiresVerification,
      );
    } catch (error) {
      return AuthResult(
        success: false,
        message: ApiClient.mapError(error).message,
      );
    }
  }

  Future<AuthResult> verifyCode({
    required String email,
    required String code,
  }) async {
    const List<String> endpoints = <String>['/api/auth/2fa/validar-codigo'];

    for (final String endpoint in endpoints) {
      try {
        final response = await ApiClient.instance.dio
            .post<Map<String, dynamic>>(
              endpoint,
              data: <String, String>{
                'email': email,
                'code': code,
                'codigo': code,
              },
            );

        final Map<String, dynamic> data = response.data ?? <String, dynamic>{};
        final bool ok = _isSuccessPayload(data);
        final String message =
            (data['mensagem'] ??
                    data['message'] ??
                    (ok
                        ? 'Email verificado com sucesso!'
                        : 'Falha na verificação.'))
                .toString();

        return AuthResult(success: ok, message: message);
      } catch (error) {
        if (error is DioException && error.response?.statusCode == 404) {
          continue;
        }
        return AuthResult(
          success: false,
          message: ApiClient.mapError(error).message,
        );
      }
    }

    return const AuthResult(
      success: false,
      message: 'Verificação por código não está habilitada nesta API.',
    );
  }

  Future<AuthResult> resendCode({required String email}) async {
    const List<String> endpoints = <String>['/api/auth/2fa/enviar-codigo'];

    for (final String endpoint in endpoints) {
      try {
        final response = await ApiClient.instance.dio
            .post<Map<String, dynamic>>(
              endpoint,
              data: <String, String>{'email': email},
            );

        final Map<String, dynamic> data = response.data ?? <String, dynamic>{};
        final bool ok = _isSuccessPayload(data);
        final String message =
            (data['mensagem'] ??
                    data['message'] ??
                    (ok
                        ? 'Código reenviado com sucesso!'
                        : 'Falha ao reenviar código.'))
                .toString();

        return AuthResult(success: ok, message: message);
      } catch (error) {
        if (error is DioException && error.response?.statusCode == 404) {
          continue;
        }
        return AuthResult(
          success: false,
          message: ApiClient.mapError(error).message,
        );
      }
    }

    return const AuthResult(
      success: false,
      message: 'Reenvio de código não está habilitado nesta API.',
    );
  }

  Future<void> persistAuthSession({
    required String token,
    required String email,
    required String userType,
    String? userId,
    String? name,
    String? fotoPerfil,
  }) async {
    await _storage.write(key: StorageKeys.jwtToken, value: token);
    await _storage.write(key: StorageKeys.userEmail, value: email);
    await _storage.write(key: StorageKeys.userType, value: userType);
    if (userId != null && userId.isNotEmpty) {
      await _storage.write(key: StorageKeys.userId, value: userId);
    }
    if (name != null && name.isNotEmpty) {
      await _storage.write(key: StorageKeys.userName, value: name);
    }
    await _storage.write(key: StorageKeys.userPhoto, value: fotoPerfil ?? '');
  }

  Future<void> logout() async {
    await _storage.delete(key: StorageKeys.jwtToken);
    await _storage.delete(key: StorageKeys.userName);
    await _storage.delete(key: StorageKeys.userEmail);
    await _storage.delete(key: StorageKeys.userType);
    await _storage.delete(key: StorageKeys.userId);
    await _storage.delete(key: StorageKeys.userPhoto);
  }

  Map<String, dynamic> _extractUserMap(Map<String, dynamic> data) {
    if (data['user'] is Map<String, dynamic>) {
      return data['user'] as Map<String, dynamic>;
    }
    if (data['usuario'] is Map<String, dynamic>) {
      return data['usuario'] as Map<String, dynamic>;
    }
    return <String, dynamic>{};
  }

  String _extractName(Map<String, dynamic> data, Map<String, dynamic> user) {
    final Object? nome =
        user['nome'] ?? user['name'] ?? data['nome'] ?? data['name'];
    return (nome ?? '').toString().trim();
  }

  String _extractUserType(
    Map<String, dynamic> data,
    Map<String, dynamic> user,
    String token,
  ) {
    String raw =
        (user['tipo'] ??
                user['role'] ??
                data['tipo'] ??
                data['role'] ??
                data['userType'] ??
                '')
            .toString();

    if (raw.trim().isEmpty) {
      raw = _extractUserTypeFromToken(token);
    }

    final String normalized = raw.trim().toLowerCase();
    if (normalized == 'admin') {
      return 'admin';
    }
    return 'user';
  }

  String _extractUserTypeFromToken(String token) {
    try {
      final List<String> parts = token.split('.');
      if (parts.length < 2) {
        return '';
      }

      final String payload = utf8.decode(
        base64Url.decode(base64Url.normalize(parts[1])),
      );
      final Object? decoded = jsonDecode(payload);
      if (decoded is! Map<String, dynamic>) {
        return '';
      }

      return (decoded['tipo'] ?? decoded['role'] ?? '').toString();
    } catch (_) {
      return '';
    }
  }

  bool _messageIndicatesVerification(String message) {
    final String normalized = message.toLowerCase();
    final bool hasVerificationContext =
        normalized.contains('verific') ||
        normalized.contains('nao verificado') ||
        normalized.contains('não verificado');

    return hasVerificationContext &&
        (normalized.contains('email') ||
            normalized.contains('e-mail') ||
            normalized.contains('codigo') ||
            normalized.contains('código') ||
            normalized.contains('usuario'));
  }

  bool _extractRequiresVerification(
    Map<String, dynamic> data, {
    required String fallbackMessage,
  }) {
    final Object? explicit =
        data['requiresVerification'] ?? data['precisaVerificacao'];
    if (explicit is bool) {
      return explicit;
    }

    final String redirectTo = (data['redirectTo'] ?? '').toString();
    if (redirectTo.contains('verificar-2fa')) {
      return true;
    }

    return _messageIndicatesVerification(fallbackMessage);
  }

  bool _isSuccessPayload(Map<String, dynamic> data) {
    final Object? success = data['success'] ?? data['sucesso'];
    if (success is bool) {
      return success;
    }
    final String? error = (data['erro'] ?? data['error'])?.toString();
    if (error != null && error.trim().isNotEmpty) {
      return false;
    }
    return true;
  }
}
