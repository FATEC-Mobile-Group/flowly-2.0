import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:meu_app/src/app/flowly_theme.dart';
import 'package:meu_app/src/services/auth_service.dart';
import 'package:meu_app/src/widgets/auth_background.dart';
import 'package:meu_app/src/widgets/flowly_card.dart';
import 'package:meu_app/src/widgets/validated_text_field.dart';

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
  final TextEditingController _nameController = TextEditingController();
  final TextEditingController _emailController = TextEditingController();
  final TextEditingController _passwordController = TextEditingController();
  final AuthService _authService = AuthService();

  bool _obscurePassword = true;
  bool _isSubmitting = false;
  bool _termsAccepted = false;

  @override
  void dispose() {
    _nameController.dispose();
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate() || _isSubmitting) {
      return;
    }

    if (!_termsAccepted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Leia e aceite os Termos de Uso e a Política de Privacidade.',
          ),
        ),
      );
      return;
    }

    setState(() => _isSubmitting = true);
    final messenger = ScaffoldMessenger.of(context);

    final result = await _authService.register(
      nome: _nameController.text.trim(),
      email: _emailController.text.trim(),
      senha: _passwordController.text,
      termsAccepted: _termsAccepted,
    );

    if (!mounted) {
      return;
    }

    setState(() => _isSubmitting = false);

    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(
      SnackBar(
        content: Text(result.message),
        backgroundColor: result.success
            ? const Color(0xFF0D9C6E)
            : const Color(0xFFC62828),
      ),
    );

    if (result.success) {
      final String encodedEmail = Uri.encodeComponent(
        _emailController.text.trim(),
      );
      if (result.requiresVerification) {
        context.go('/verify-email?email=$encodedEmail');
        return;
      }
      context.go('/login?email=$encodedEmail');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: AuthBackground(
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 460),
                child: FlowlyCard(
                  child: Form(
                    key: _formKey,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        Text(
                          'Criar conta',
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.headlineSmall
                              ?.copyWith(
                                color: flowlyText,
                                fontWeight: FontWeight.w700,
                              ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Preencha os dados para começar a organizar seus projetos.',
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                        const SizedBox(height: 20),
                        ValidatedTextField(
                          controller: _nameController,
                          label: 'Nome completo',
                          hint: 'Digite seu nome completo',
                          prefixIcon: Icons.person_outline,
                          validator: (String? value) {
                            if ((value ?? '').trim().isEmpty) {
                              return 'Informe seu nome.';
                            }
                            if ((value ?? '').trim().length < 3) {
                              return 'O nome deve ter no mínimo 3 caracteres.';
                            }
                            return null;
                          },
                        ),
                        const SizedBox(height: 16),
                        ValidatedTextField(
                          controller: _emailController,
                          label: 'E-mail',
                          hint: 'seu.email@exemplo.com',
                          prefixIcon: Icons.email_outlined,
                          keyboardType: TextInputType.emailAddress,
                          validator: (String? value) {
                            final String email = (value ?? '').trim();
                            if (email.isEmpty) {
                              return 'Informe seu e-mail.';
                            }
                            if (!email.contains('@')) {
                              return 'E-mail inválido.';
                            }
                            return null;
                          },
                        ),
                        const SizedBox(height: 16),
                        ValidatedTextField(
                          controller: _passwordController,
                          label: 'Senha',
                          hint:
                              'Mínimo de 8 caracteres, com maiúscula, número e símbolo',
                          prefixIcon: Icons.lock_outlined,
                          obscureText: _obscurePassword,
                          suffixIcon: _obscurePassword
                              ? Icons.visibility_outlined
                              : Icons.visibility_off_outlined,
                          onSuffixIconPressed: () => setState(
                            () => _obscurePassword = !_obscurePassword,
                          ),
                          validator: (String? value) {
                            final String password = value ?? '';
                            if (password.isEmpty) {
                              return 'Informe sua senha.';
                            }
                            if (password.length < 8) {
                              return 'Use no mínimo 8 caracteres.';
                            }
                            if (!RegExp(r'[A-Z]').hasMatch(password) ||
                                !RegExp(r'[a-z]').hasMatch(password) ||
                                !RegExp(r'[0-9]').hasMatch(password) ||
                                !RegExp(
                                  r'[!@#$%^&*(),.?":{}|<>]',
                                ).hasMatch(password)) {
                              return 'Inclua maiúscula, minúscula, número e caractere especial.';
                            }
                            return null;
                          },
                        ),
                        const SizedBox(height: 16),
                        CheckboxListTile(
                          value: _termsAccepted,
                          onChanged: _isSubmitting
                              ? null
                              : (bool? value) => setState(
                                  () => _termsAccepted = value ?? false,
                                ),
                          controlAffinity: ListTileControlAffinity.leading,
                          contentPadding: EdgeInsets.zero,
                          title: const Text(
                            'Li e aceito os Termos de Uso e a Política de Privacidade.',
                          ),
                        ),
                        const SizedBox(height: 12),
                        FilledButton(
                          onPressed: _isSubmitting ? null : _submit,
                          style: FilledButton.styleFrom(
                            backgroundColor: flowlySecondary,
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(vertical: 16),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(14),
                            ),
                          ),
                          child: _isSubmitting
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white,
                                  ),
                                )
                              : const Text('Registrar'),
                        ),
                        const SizedBox(height: 10),
                        TextButton(
                          onPressed: _isSubmitting
                              ? null
                              : () => context.go('/login'),
                          child: const Text('Voltar para login'),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
