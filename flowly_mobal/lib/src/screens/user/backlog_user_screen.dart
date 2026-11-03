import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:meu_app/src/models/task.dart';
import 'package:meu_app/src/services/auth_service.dart';
import 'package:meu_app/src/services/task_service.dart';
import 'package:meu_app/src/widgets/app_navigation_drawer.dart';
import 'package:meu_app/src/widgets/auth_background.dart';

class BacklogUserScreen extends StatefulWidget {
  const BacklogUserScreen({super.key});

  @override
  State<BacklogUserScreen> createState() => _BacklogUserScreenState();
}

class _BacklogUserScreenState extends State<BacklogUserScreen> {
  final TaskService _taskService = TaskService();
  final AuthService _authService = AuthService();

  Future<List<Task>>? _backlogFuture;
  bool _isClaiming = false;

  @override
  void initState() {
    super.initState();
    _backlogFuture = _taskService.listarBacklog();
  }

  Future<void> _reload() async {
    setState(() {
      _backlogFuture = _taskService.listarBacklog();
    });
    await _backlogFuture;
  }

  Future<void> _logout() async {
    await _authService.logout();
    if (!mounted) {
      return;
    }
    context.go('/login');
  }

  Future<void> _showDetails(Task task) async {
    if (!mounted) {
      return;
    }

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xFF1B1E2E),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (BuildContext context) {
        return StatefulBuilder(
          builder: (BuildContext context, StateSetter setModalState) {
            Future<void> claimTask() async {
              if (_isClaiming) {
                return;
              }
              setModalState(() => _isClaiming = true);
              try {
                await _taskService.atribuirParaMim(task.id);
                if (!mounted || !context.mounted) {
                  return;
                }
                Navigator.of(context).pop();
                ScaffoldMessenger.of(this.context).showSnackBar(
                  const SnackBar(
                    content: Text(
                      'Tarefa atribuída para você. Ela já aparece no Kanban e no Meu Painel.',
                    ),
                  ),
                );
                await _reload();
              } catch (error) {
                if (!mounted) {
                  return;
                }
                ScaffoldMessenger.of(this.context).showSnackBar(
                  SnackBar(content: Text('Erro ao atribuir tarefa: $error')),
                );
              } finally {
                if (mounted && context.mounted) {
                  setModalState(() => _isClaiming = false);
                }
              }
            }

            return SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 20),
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        task.nome.isEmpty ? task.descricao : task.nome,
                        style: Theme.of(context).textTheme.titleLarge?.copyWith(
                          color: Colors.white,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 12),
                      Text(
                        task.descricao.isEmpty ? '-' : task.descricao,
                        style: Theme.of(
                          context,
                        ).textTheme.bodyMedium?.copyWith(color: Colors.white70),
                      ),
                      const SizedBox(height: 12),
                      Text(
                        'Status: ${task.status.label}',
                        style: Theme.of(
                          context,
                        ).textTheme.bodyMedium?.copyWith(color: Colors.white),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Prioridade: ${task.prioridade.label}',
                        style: Theme.of(
                          context,
                        ).textTheme.bodyMedium?.copyWith(color: Colors.white),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Equipe: ${task.equipeNome ?? 'Não informada'}',
                        style: Theme.of(
                          context,
                        ).textTheme.bodyMedium?.copyWith(color: Colors.white),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        task.prazo == null
                            ? 'Entrega: -'
                            : 'Entrega: ${task.prazo!.day.toString().padLeft(2, '0')}/${task.prazo!.month.toString().padLeft(2, '0')}/${task.prazo!.year}',
                        style: Theme.of(
                          context,
                        ).textTheme.bodyMedium?.copyWith(color: Colors.white),
                      ),
                      const SizedBox(height: 20),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton.icon(
                          onPressed: _isClaiming ? null : claimTask,
                          icon: _isClaiming
                              ? const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white,
                                  ),
                                )
                              : const Icon(Icons.assignment_ind_outlined),
                          label: Text(
                            _isClaiming ? 'Atribuindo...' : 'Atribuir para mim',
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final bool compact = MediaQuery.of(context).size.width < 390;
    return AuthBackground(
      child: Scaffold(
        backgroundColor: Colors.transparent,
        drawer: AppNavigationDrawer(
          currentRoute: '/backlog',
          onLogout: _logout,
        ),
        appBar: AppBar(title: const Text('Backlog')),
        body: FutureBuilder<List<Task>>(
          future: _backlogFuture,
          builder: (BuildContext context, AsyncSnapshot<List<Task>> snapshot) {
            if (snapshot.connectionState == ConnectionState.waiting) {
              return const Center(child: CircularProgressIndicator());
            }

            if (snapshot.hasError) {
              return Center(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: <Widget>[
                      Text('Erro ao carregar backlog: ${snapshot.error}'),
                      const SizedBox(height: 12),
                      FilledButton(
                        onPressed: _reload,
                        child: const Text('Tentar novamente'),
                      ),
                    ],
                  ),
                ),
              );
            }

            final List<Task> tasks = snapshot.data ?? <Task>[];
            if (tasks.isEmpty) {
              return RefreshIndicator(
                onRefresh: _reload,
                child: ListView(
                  children: const <Widget>[
                    SizedBox(height: 160),
                    Center(
                      child: Text('Nenhuma tarefa sem responsável no backlog.'),
                    ),
                  ],
                ),
              );
            }

            return RefreshIndicator(
              onRefresh: _reload,
              child: ListView(
                padding: EdgeInsets.all(compact ? 12 : 16),
                children: <Widget>[
                  Container(
                    padding: EdgeInsets.all(compact ? 14 : 16),
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        colors: <Color>[Color(0xFF1E4FA8), Color(0xFF0B1F4D)],
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                      ),
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: Colors.white24),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: <Widget>[
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(
                              'Backlog da equipe',
                              style: Theme.of(context).textTheme.titleLarge
                                  ?.copyWith(
                                    color: Colors.white,
                                    fontWeight: FontWeight.w800,
                                  ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              'Escolha uma tarefa para assumir',
                              style: Theme.of(context).textTheme.bodySmall
                                  ?.copyWith(color: Colors.white70),
                            ),
                          ],
                        ),
                        CircleAvatar(
                          radius: compact ? 20 : 24,
                          backgroundColor: Colors.white24,
                          child: Text(
                            tasks.length.toString(),
                            style: TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.w700,
                              fontSize: compact ? 14 : 16,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  SizedBox(height: compact ? 10 : 14),
                  ...tasks.map((Task task) {
                    final String title = task.nome.isEmpty
                        ? task.descricao
                        : task.nome;
                    return Card(
                      margin: EdgeInsets.only(bottom: compact ? 12 : 14),
                      child: ListTile(
                        leading: const Icon(Icons.inventory_2_outlined),
                        title: Text(title),
                        subtitle: Text(
                          'Equipe: ${task.equipeNome ?? 'Não informada'}',
                        ),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => _showDetails(task),
                      ),
                    );
                  }),
                ],
              ),
            );
          },
        ),
      ),
    );
  }
}
