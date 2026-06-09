import 'package:flutter/foundation.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';

class ApiConfig {
  static const String _productionBaseUrl =
      'https://flowly-api-backend-646126851973.southamerica-east1.run.app';

  static const String _definedBaseUrl = String.fromEnvironment(
    'FLOWLY_API_URL',
  );

  static String get baseUrl {
    final String dartDefineBaseUrl = _definedBaseUrl.trim();
    if (dartDefineBaseUrl.isNotEmpty) {
      return _normalizeBaseUrl(dartDefineBaseUrl);
    }

    final String envBaseUrl = dotenv.isInitialized
        ? (dotenv.env['FLOWLY_API_URL'] ?? '').trim()
        : '';
    if (envBaseUrl.isNotEmpty) {
      return _normalizeBaseUrl(envBaseUrl);
    }

    if (kDebugMode) {
      return _normalizeBaseUrl(
        kIsWeb ? 'http://localhost:5000' : 'http://10.0.2.2:5000',
      );
    }

    return _normalizeBaseUrl(_productionBaseUrl);
  }

  static String _normalizeBaseUrl(String value) {
    final String normalized = value.trim().replaceFirst(RegExp(r'/+$'), '');
    if (normalized.endsWith('/api')) {
      return normalized.substring(0, normalized.length - 4);
    }
    return normalized;
  }
}
