import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:meu_app/src/app/flowly_theme.dart';
import 'package:meu_app/src/models/auth_result.dart';
import 'package:meu_app/src/services/face_service.dart';

enum FaceAuthMode { enroll, verify }

class FaceAuthScreen extends StatefulWidget {
  const FaceAuthScreen({
    super.key,
    required this.mode,
    required this.faceSessionToken,
    required this.userName,
    required this.onSuccess,
    this.onSkip,
    this.onCancel,
  });

  final FaceAuthMode mode;
  final String faceSessionToken;
  final String userName;
  final ValueChanged<AuthResult> onSuccess;
  final VoidCallback? onSkip;
  final VoidCallback? onCancel;

  @override
  State<FaceAuthScreen> createState() => _FaceAuthScreenState();
}

class _FaceAuthScreenState extends State<FaceAuthScreen> {
  final FaceService _faceService = FaceService();
  final ImagePicker _picker = ImagePicker();

  String? _previewBase64;
  bool _isSubmitting = false;

  Future<void> _capturePhoto() async {
    final XFile? photo = await _picker.pickImage(
      source: ImageSource.camera,
      preferredCameraDevice: CameraDevice.front,
      imageQuality: 85,
      maxWidth: 640,
    );

    if (photo == null || !mounted) {
      return;
    }

    final bytes = await photo.readAsBytes();
    setState(() {
      _previewBase64 = 'data:image/jpeg;base64,${base64Encode(bytes)}';
    });
  }

  Future<void> _submit() async {
    if (_previewBase64 == null || _isSubmitting) {
      return;
    }

    setState(() => _isSubmitting = true);

    final AuthResult result = widget.mode == FaceAuthMode.verify
        ? await _faceService.verifyWithSession(
            faceSessionToken: widget.faceSessionToken,
            imageBase64: _previewBase64!,
          )
        : await _faceService.enrollWithSession(
            faceSessionToken: widget.faceSessionToken,
            imageBase64: _previewBase64!,
          );

    if (!mounted) {
      return;
    }

    setState(() => _isSubmitting = false);
    widget.onSuccess(result);
  }

  Future<void> _skip() async {
    if (_isSubmitting || widget.onSkip == null) {
      return;
    }

    setState(() => _isSubmitting = true);
    final AuthResult result = await _faceService.skipEnrollment(
      faceSessionToken: widget.faceSessionToken,
    );

    if (!mounted) {
      return;
    }

    setState(() => _isSubmitting = false);
    widget.onSuccess(result);
  }

  @override
  Widget build(BuildContext context) {
    final bool isVerify = widget.mode == FaceAuthMode.verify;
    final String title = isVerify ? 'Verificação facial' : 'Cadastro facial (opcional)';
    final String subtitle = isVerify
        ? 'Olá, ${widget.userName}. Confirme sua identidade para concluir o login.'
        : 'Cadastre seu rosto para uma camada extra de segurança no login.';

    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        leading: widget.onCancel == null
            ? null
            : IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: _isSubmitting ? null : widget.onCancel,
              ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(subtitle, style: Theme.of(context).textTheme.bodyLarge),
            const SizedBox(height: 20),
            if (_previewBase64 != null)
              ClipRRect(
                borderRadius: BorderRadius.circular(16),
                child: Image.memory(
                  base64Decode(_previewBase64!.split(',').last),
                  height: 280,
                  fit: BoxFit.cover,
                ),
              )
            else
              Container(
                height: 280,
                decoration: BoxDecoration(
                  color: flowlySurface,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: flowlyBorder),
                ),
                child: const Center(
                  child: Icon(Icons.face_retouching_natural, size: 72, color: flowlyMutedText),
                ),
              ),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              onPressed: _isSubmitting ? null : _capturePhoto,
              icon: const Icon(Icons.camera_alt_outlined),
              label: Text(_previewBase64 == null ? 'Capturar rosto' : 'Tirar outra foto'),
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _isSubmitting || _previewBase64 == null ? null : _submit,
              style: FilledButton.styleFrom(
                backgroundColor: flowlySecondary,
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
              child: _isSubmitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                    )
                  : Text(isVerify ? 'Verificar e entrar' : 'Cadastrar e entrar'),
            ),
            if (!isVerify && widget.onSkip != null) ...<Widget>[
              const SizedBox(height: 10),
              OutlinedButton(
                onPressed: _isSubmitting ? null : _skip,
                child: const Text('Pular por agora'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
