import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:meu_app/src/app/flowly_theme.dart';
import 'package:meu_app/src/services/face_service.dart';

class FaceProfileScreen extends StatefulWidget {
  const FaceProfileScreen({super.key});

  @override
  State<FaceProfileScreen> createState() => _FaceProfileScreenState();
}

class _FaceProfileScreenState extends State<FaceProfileScreen> {
  final FaceService _faceService = FaceService();
  final ImagePicker _picker = ImagePicker();

  bool _loadingStatus = true;
  bool _enrolled = false;
  bool _submitting = false;
  String? _previewBase64;
  String _message = '';

  @override
  void initState() {
    super.initState();
    _loadStatus();
  }

  Future<void> _loadStatus() async {
    try {
      final status = await _faceService.getStatus();
      setState(() {
        _enrolled = status['enrolled'] == true;
        _loadingStatus = false;
      });
    } catch (_) {
      setState(() => _loadingStatus = false);
    }
  }

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
      _message = '';
    });
  }

  Future<void> _submit() async {
    if (_previewBase64 == null) {
      setState(() => _message = 'Capture uma foto do rosto antes de salvar.');
      return;
    }

    setState(() {
      _submitting = true;
      _message = '';
    });

    final result = await _faceService.enrollFromProfile(imageBase64: _previewBase64!);

    if (!mounted) {
      return;
    }

    setState(() {
      _submitting = false;
      _message = result.message;
      if (result.success) {
        _enrolled = true;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Verificação facial'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
      ),
      body: _loadingStatus
          ? const Center(child: CircularProgressIndicator())
          : SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Text(
                    _enrolled
                        ? 'Seu rosto já está cadastrado. Você pode recadastrar para atualizar.'
                        : 'Cadastre seu rosto para usar verificação facial no login (opcional).',
                  ),
                  const SizedBox(height: 16),
                  if (_previewBase64 != null)
                    ClipRRect(
                      borderRadius: BorderRadius.circular(16),
                      child: Image.memory(
                        base64Decode(_previewBase64!.split(',').last),
                        height: 260,
                        fit: BoxFit.cover,
                      ),
                    )
                  else
                    Container(
                      height: 260,
                      decoration: BoxDecoration(
                        color: flowlySurface,
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: flowlyBorder),
                      ),
                      child: const Center(
                        child: Icon(Icons.face, size: 72, color: flowlyMutedText),
                      ),
                    ),
                  const SizedBox(height: 16),
                  OutlinedButton.icon(
                    onPressed: _submitting ? null : _capturePhoto,
                    icon: const Icon(Icons.camera_alt_outlined),
                    label: const Text('Capturar rosto'),
                  ),
                  const SizedBox(height: 12),
                  FilledButton(
                    onPressed: _submitting || _previewBase64 == null ? null : _submit,
                    style: FilledButton.styleFrom(backgroundColor: flowlySecondary),
                    child: Text(
                      _submitting
                          ? 'Salvando...'
                          : _enrolled
                              ? 'Atualizar rosto'
                              : 'Cadastrar verificação facial',
                    ),
                  ),
                  if (_message.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 12),
                    Text(
                      _message,
                      style: TextStyle(
                        color: _message.toLowerCase().contains('sucesso')
                            ? const Color(0xFF0D9C6E)
                            : const Color(0xFFC62828),
                      ),
                    ),
                  ],
                ],
              ),
            ),
    );
  }
}
