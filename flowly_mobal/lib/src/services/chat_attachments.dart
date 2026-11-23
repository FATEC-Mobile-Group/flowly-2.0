import 'dart:math';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:file_picker/file_picker.dart';

/// Anexos do chat da equipe: formatos e limite iguais aos do backend (PNG, JPEG e PDF, até 10 MB).
/// A API continua validando tudo (tipo declarado, extensão, conteúdo e moderação).
const int kChatAttachmentMaxBytes = 10 * 1024 * 1024;
const List<String> kChatAttachmentExtensions = <String>[
  'png',
  'jpg',
  'jpeg',
  'pdf',
];

const Map<String, String> _mimeByExtension = <String, String>{
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'pdf': 'application/pdf',
};

String _extensionOf(String name) {
  final int dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
}

/// Tipo declarado no multipart. O Multer do backend recusa `application/octet-stream`.
String? chatMimeTypeFor(String name) => _mimeByExtension[_extensionOf(name)];

/// Arquivo escolhido para envio: caminho (Android/iOS) ou bytes (testes/plataformas sem caminho).
class PickedChatFile {
  const PickedChatFile({
    required this.name,
    required this.size,
    this.path,
    this.bytes,
  });

  final String name;
  final int size;
  final String? path;
  final Uint8List? bytes;

  String? get mimetype => chatMimeTypeFor(name);
  bool get isImage => mimetype == 'image/png' || mimetype == 'image/jpeg';

  /// Identifica o conteúdo escolhido para decidir se uma nova tentativa reaproveita o clientMessageId.
  String get fingerprint => '$name|$size|${path ?? ''}|${bytes?.length ?? ''}';
}

/// Aviso compreensível para a pessoa (nunca inclui URL, token ou erro interno).
class ChatAttachmentException implements Exception {
  const ChatAttachmentException(
    this.title,
    this.message, {
    this.status,
    this.canceled = false,
    this.warning = false,
  });

  final String title;
  final String message;
  final int? status;
  final bool canceled;
  final bool warning;

  @override
  String toString() => '$title: $message';
}

/// Validação antes do upload (mesmas regras do backend). Nulo quando o arquivo é aceito.
ChatAttachmentException? validateChatFile(PickedChatFile file) {
  if (file.mimetype == null) {
    return const ChatAttachmentException(
      'Tipo de arquivo não permitido',
      'Envie uma imagem PNG ou JPG, ou um PDF.',
    );
  }
  if (file.size <= 0) {
    return const ChatAttachmentException(
      'Arquivo vazio',
      'Escolha um arquivo com conteúdo.',
    );
  }
  if (file.size > kChatAttachmentMaxBytes) {
    return const ChatAttachmentException(
      'Arquivo muito grande',
      'O limite é 10 MB por arquivo.',
    );
  }
  if (file.path == null && file.bytes == null) {
    return const ChatAttachmentException(
      'Arquivo indisponível',
      'Não foi possível ler o arquivo escolhido. Tente novamente.',
    );
  }
  return null;
}

/// UUID v4 em minúsculas, como o backend exige.
String newClientMessageId([Random? random]) {
  final Random source = random ?? Random.secure();
  final List<int> bytes = List<int>.generate(16, (_) => source.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final String hex = bytes
      .map((int b) => b.toRadixString(16).padLeft(2, '0'))
      .join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-'
      '${hex.substring(16, 20)}-${hex.substring(20)}';
}

String formatChatBytes(int bytes) {
  if (bytes < 1024) {
    return '$bytes B';
  }
  if (bytes < 1024 * 1024) {
    return '${(bytes / 1024).round()} KB';
  }
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1).replaceAll('.', ',')} MB';
}

/// Só os caminhos que o backend gera para anexos; qualquer outro valor do payload é ignorado.
final RegExp _attachmentPath = RegExp(
  r'^/api/equipes/[a-f\d]{24}/mensagens/[a-f\d]{24}/anexo(\?disposition=inline)?$',
  caseSensitive: false,
);

bool isValidAttachmentPath(String? path) =>
    path != null && _attachmentPath.hasMatch(path);

/// Nome para salvar: sem caminho nem caracteres que o sistema de arquivos recusa.
String safeDownloadName(String name) {
  final String base = name
      .split(RegExp(r'[\\/]'))
      .last
      .replaceAll(RegExp(r'[\x00-\x1f\x7f<>:"|?*]'), '')
      .trim();
  return base.isEmpty ? 'arquivo' : base;
}

bool _isCanceled(Object error) =>
    error is DioException && error.type == DioExceptionType.cancel;

bool _noResponse(Object error) =>
    error is DioException && error.response == null;

/// Mensagem do servidor só quando é um texto curto de erro de validação (4xx); 5xx nunca é exibido.
String? _serverText(DioException error) {
  final Object? data = error.response?.data;
  final int status = error.response?.statusCode ?? 0;
  if (status < 400 || status >= 500 || data is! Map) {
    return null;
  }
  final Object? erro = data['erro'];
  if (erro is! String) {
    return null;
  }
  final String text = erro.trim();
  return text.isEmpty || text.length > 300 ? null : text;
}

String? _code(DioException error) {
  final Object? data = error.response?.data;
  return data is Map && data['codigo'] is String
      ? data['codigo'] as String
      : null;
}

/// Erros do upload (contrato do chatAttachmentController).
ChatAttachmentException describeChatUploadError(Object error) {
  if (error is ChatAttachmentException) {
    return error;
  }
  if (_isCanceled(error)) {
    return const ChatAttachmentException(
      'Envio cancelado',
      'O envio foi interrompido. Se o arquivo já tinha chegado ao servidor, ele aparecerá no chat; '
          'enviar de novo não duplica.',
      canceled: true,
      warning: true,
    );
  }
  if (error is! DioException || _noResponse(error)) {
    return const ChatAttachmentException(
      'Falha de conexão',
      'Não foi possível enviar o arquivo. Verifique sua conexão; o arquivo e a legenda foram mantidos.',
      warning: true,
    );
  }
  final int status = error.response?.statusCode ?? 0;
  final String? text = _serverText(error);
  final String? code = _code(error);
  switch (status) {
    case 400:
      return ChatAttachmentException(
        'Arquivo não aceito',
        text ?? 'Não foi possível ler o envio. Escolha o arquivo novamente.',
        status: status,
      );
    case 401:
      return const ChatAttachmentException(
        'Sessão encerrada',
        'Entre novamente para enviar arquivos.',
        status: 401,
      );
    case 404:
      return const ChatAttachmentException(
        'Chat indisponível',
        'Você não tem mais acesso a esta equipe ou ela não existe.',
        status: 404,
      );
    case 409:
      return const ChatAttachmentException(
        'Envio em conflito',
        'Este envio já tinha sido registrado com outro conteúdo. Envie novamente para criar um novo envio.',
        status: 409,
      );
    case 413:
      return const ChatAttachmentException(
        'Arquivo muito grande',
        'O limite é 10 MB por arquivo.',
        status: 413,
      );
    case 422:
      if (code == 'caption_blocked') {
        return ChatAttachmentException(
          'Legenda não aceita',
          text ?? 'Revise a legenda e tente novamente.',
          status: status,
        );
      }
      return ChatAttachmentException(
        code == 'upload_blocked' ? 'Arquivo bloqueado' : 'Arquivo não aceito',
        text ?? 'O arquivo não foi aceito. Escolha outro arquivo.',
        status: status,
      );
    case 429:
      return const ChatAttachmentException(
        'Muitos envios',
        'Aguarde um pouco e tente novamente.',
        status: 429,
        warning: true,
      );
    case 503:
      return ChatAttachmentException(
        code == 'moderation_unavailable'
            ? 'Verificação indisponível'
            : 'Serviço indisponível',
        code == 'moderation_unavailable'
            ? 'Não foi possível verificar a segurança do arquivo agora. Tente novamente em instantes.'
            : 'Não foi possível guardar o arquivo agora. Tente novamente em instantes.',
        status: status,
        warning: true,
      );
    default:
      return ChatAttachmentException(
        'Falha no envio',
        'Não foi possível enviar o arquivo agora. Tente novamente.',
        status: status,
      );
  }
}

/// Erros ao abrir ou baixar: a resposta vem em bytes, então a mensagem sai só do status.
ChatAttachmentException describeChatDownloadError(Object error) {
  if (error is ChatAttachmentException) {
    return error;
  }
  if (_isCanceled(error)) {
    return const ChatAttachmentException(
      'Download cancelado',
      '',
      canceled: true,
    );
  }
  if (error is! DioException || _noResponse(error)) {
    return const ChatAttachmentException(
      'Falha de conexão',
      'Não foi possível carregar o arquivo. Verifique sua conexão e tente novamente.',
      warning: true,
    );
  }
  final int status = error.response?.statusCode ?? 0;
  if (status == 404) {
    return const ChatAttachmentException(
      'Arquivo indisponível',
      'Este anexo não está mais disponível.',
      status: 404,
    );
  }
  if (status == 401 || status == 403) {
    return ChatAttachmentException(
      'Acesso negado',
      'Você não tem acesso a este anexo.',
      status: status,
    );
  }
  if (status == 503) {
    return const ChatAttachmentException(
      'Armazenamento indisponível',
      'Não foi possível acessar o arquivo agora. Tente novamente em instantes.',
      status: 503,
      warning: true,
    );
  }
  return ChatAttachmentException(
    'Falha ao carregar',
    'Não foi possível carregar o arquivo.',
    status: status,
  );
}

const ChatAttachmentException invalidAttachmentPath = ChatAttachmentException(
  'Arquivo indisponível',
  'Este anexo não está mais disponível.',
);

/// Acesso ao seletor e ao "Salvar como" nativos. O seletor do sistema e o diálogo de salvar (SAF no
/// Android) não exigem permissão ampla de armazenamento. Substituível nos testes.
class ChatFileGateway {
  const ChatFileGateway();

  Future<PickedChatFile?> pick() async {
    final FilePickerResult? result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: kChatAttachmentExtensions,
    );
    final PlatformFile? file = result?.files.isEmpty ?? true
        ? null
        : result!.files.single;
    if (file == null) {
      return null;
    }
    return PickedChatFile(
      name: file.name,
      size: file.size,
      path: file.path,
      bytes: file.bytes,
    );
  }

  /// Salva onde a pessoa escolher. Falso quando ela cancela o diálogo.
  Future<bool> save(String fileName, Uint8List bytes) async {
    final String? path = await FilePicker.platform.saveFile(
      dialogTitle: 'Salvar arquivo',
      fileName: fileName,
      bytes: bytes,
    );
    return path != null;
  }

  /// Remove as cópias que o seletor guarda no cache do app (só quando não há envio pendente).
  Future<void> clearTemporary() async {
    try {
      await FilePicker.platform.clearTemporaryFiles();
    } catch (_) {
      // Limpeza best-effort: o sistema também limpa o cache do app.
    }
  }
}
