import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:meu_app/src/app/flowly_theme.dart';
import 'package:meu_app/src/models/team.dart';
import 'package:meu_app/src/core/network/api_client.dart';
import 'package:meu_app/src/services/team_service.dart';
import 'package:meu_app/src/utils/data_entrega.dart';
import 'package:meu_app/src/widgets/flowly_button.dart';

class CreateTaskAdminScreen extends StatefulWidget {
  const CreateTaskAdminScreen({this.taskId, super.key});

  final String? taskId;

  @override
  State<CreateTaskAdminScreen> createState() => _CreateTaskAdminScreenState();
}

class _CreateTaskAdminScreenState extends State<CreateTaskAdminScreen> {
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
  final TextEditingController _nameController = TextEditingController();
  final TextEditingController _detailsController = TextEditingController();
  final TextEditingController _dateController = TextEditingController();
  DateTime? _dataEntregaOriginal;
  final TextEditingController _timeController = TextEditingController();
  final TeamService _teamService = TeamService();

  List<Team> _teams = <Team>[];
  List<TeamMember> _members = <TeamMember>[];
  String? _selectedTeamId;
  String? _selectedUserId;
  String _urgencia = 'baixa';
  bool _isLoading = false;
  bool _loadingInitialData = true;

  @override
  void initState() {
    super.initState();
    _loadInitialData();
  }

  Future<void> _loadInitialData() async {
    try {
      final teams = await _teamService.listarEquipes();
      if (!mounted) return;
      setState(() {
        _teams = teams;
      });

      if (widget.taskId != null) {
        final response = await ApiClient.instance.dio.get<Map<String, dynamic>>(
          '/api/tarefas/${widget.taskId}/detalhes',
        );
        final Map<String, dynamic> body = response.data ?? <String, dynamic>{};
        final Map<String, dynamic> task =
            (body['tarefa'] as Map<String, dynamic>?) ?? body;
        if (!mounted) return;
        _nameController.text = (task['nome'] ?? task['descricao'] ?? '')
            .toString();
        _detailsController.text = (task['detalhes'] ?? task['descricao'] ?? '')
            .toString();
        final String? rawDate = (task['dataEntrega'] ?? task['prazo'])
            ?.toString();
        _dateController.text = rawDate != null && rawDate.isNotEmpty
            ? rawDate.substring(0, 10)
            : '';
        _dataEntregaOriginal = DateTime.tryParse(_dateController.text);
        _timeController.text = (task['tempoEstimado'] ?? '').toString();
        _urgencia = (task['urgencia'] ?? 'baixa').toString();
        _selectedTeamId = _resolveId(task['equipe']) ?? _selectedTeamId;
        _selectedUserId = _resolveId(task['user']) ?? _selectedUserId;
      } else if (_teams.isNotEmpty) {
        _selectedTeamId = _teams.first.id;
      }

      if (_selectedTeamId != null && _selectedTeamId!.isNotEmpty) {
        await _loadMembers(_selectedTeamId!);
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Erro ao carregar dados: $error')),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _loadingInitialData = false);
      }
    }
  }

  Future<void> _loadMembers(String teamId) async {
    final members = responsaveisElegiveis(
      await _teamService.obterMembrosEquipe(teamId),
    );
    if (!mounted) return;
    setState(() {
      _members = members;
      _selectedUserId =
          members.any((member) => member.userId == _selectedUserId)
          ? _selectedUserId
          : (members.isNotEmpty ? members.first.userId : null);
    });
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }

    if (_selectedTeamId == null || _selectedTeamId!.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Selecione uma equipe.')));
      return;
    }

    if (_selectedUserId == null || _selectedUserId!.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Selecione um usuário responsável.')),
      );
      return;
    }

    setState(() => _isLoading = true);
    try {
      final int? tempoEstimado = int.tryParse(_timeController.text);

      final Map<String, dynamic> payload = <String, dynamic>{
        'descricao': _nameController.text.trim(),
        'detalhes': _detailsController.text.trim(),
        if (_dateController.text.trim().isNotEmpty)
          'dataEntrega': _dateController.text.trim(),
        'tempoEstimado': tempoEstimado,
        'urgencia': _urgencia,
        'equipe': _selectedTeamId,
        'user': _selectedUserId,
      };

      if (widget.taskId == null) {
        await ApiClient.instance.dio.post<void>('/api/tarefas', data: payload);
      } else {
        await ApiClient.instance.dio.put<void>(
          '/api/tarefas/${widget.taskId}',
          data: payload,
        );
      }

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            widget.taskId == null ? 'Tarefa criada!' : 'Tarefa atualizada!',
          ),
          backgroundColor: const Color(0xFF0D9C6E),
        ),
      );
      context.go('/admin/tarefas');
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Erro: $error')));
      }
    } finally {
      if (mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  @override
  void dispose() {
    _nameController.dispose();
    _detailsController.dispose();
    _dateController.dispose();
    _timeController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_loadingInitialData) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    final double width = MediaQuery.of(context).size.width;
    final bool isCompact = width < 380;
    final EdgeInsets pagePadding = EdgeInsets.all(isCompact ? 12 : 16);
    final double sectionGap = isCompact ? 10 : 14;

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.taskId == null ? 'Criar Tarefa' : 'Editar Tarefa'),
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: pagePadding,
          children: <Widget>[
            Container(
              padding: EdgeInsets.all(isCompact ? 14 : 16),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: <Color>[Color(0xFF0B1F4D), Color(0xFF1E4FA8)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(18),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    widget.taskId == null ? 'Nova tarefa' : 'Editar tarefa',
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                      color: Colors.white,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Fluxo admin: defina equipe, responsável e urgência.',
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: Colors.white70),
                  ),
                ],
              ),
            ),
            SizedBox(height: sectionGap),
            Card(
              child: Padding(
                padding: EdgeInsets.all(isCompact ? 12 : 14),
                child: Column(
                  children: <Widget>[
                    TextFormField(
                      controller: _nameController,
                      style: const TextStyle(color: flowlyText),
                      cursorColor: flowlyPrimary,
                      decoration: const InputDecoration(
                        labelText: 'Nome da tarefa',
                      ),
                      validator: (value) {
                        if ((value ?? '').trim().isEmpty) {
                          return 'Informe o nome da tarefa.';
                        }
                        return null;
                      },
                    ),
                    SizedBox(height: sectionGap),
                    TextFormField(
                      controller: _detailsController,
                      style: const TextStyle(color: flowlyText),
                      cursorColor: flowlyPrimary,
                      decoration: const InputDecoration(
                        labelText: 'Descrição detalhada',
                      ),
                      minLines: 3,
                      maxLines: 5,
                    ),
                  ],
                ),
              ),
            ),
            SizedBox(height: sectionGap),
            Card(
              child: Padding(
                padding: EdgeInsets.all(isCompact ? 12 : 14),
                child: Column(
                  children: <Widget>[
                    TextFormField(
                      controller: _dateController,
                      readOnly: true,
                      onTap: _pickDate,
                      style: const TextStyle(color: flowlyText),
                      cursorColor: flowlyPrimary,
                      decoration: const InputDecoration(
                        labelText: 'Data de entrega',
                        suffixIcon: Icon(Icons.calendar_today_outlined),
                      ),
                    ),
                    SizedBox(height: sectionGap),
                    TextFormField(
                      controller: _timeController,
                      style: const TextStyle(color: flowlyText),
                      cursorColor: flowlyPrimary,
                      decoration: const InputDecoration(
                        labelText: 'Tempo estimado em minutos',
                      ),
                      keyboardType: TextInputType.number,
                    ),
                  ],
                ),
              ),
            ),
            SizedBox(height: sectionGap),
            Card(
              child: Padding(
                padding: EdgeInsets.all(isCompact ? 12 : 14),
                child: Column(
                  children: <Widget>[
                    DropdownButtonFormField<String>(
                      initialValue: _urgencia,
                      isExpanded: true,
                      style: const TextStyle(color: flowlyText),
                      dropdownColor: flowlySurface,
                      decoration: const InputDecoration(labelText: 'Urgência'),
                      items: const <DropdownMenuItem<String>>[
                        DropdownMenuItem(
                          value: 'baixa',
                          child: Text('Baixa', overflow: TextOverflow.ellipsis),
                        ),
                        DropdownMenuItem(
                          value: 'media',
                          child: Text('Média', overflow: TextOverflow.ellipsis),
                        ),
                        DropdownMenuItem(
                          value: 'alta',
                          child: Text('Alta', overflow: TextOverflow.ellipsis),
                        ),
                      ],
                      onChanged: (value) =>
                          setState(() => _urgencia = value ?? 'baixa'),
                    ),
                    SizedBox(height: sectionGap),
                    DropdownButtonFormField<String>(
                      initialValue: _selectedTeamId,
                      isExpanded: true,
                      style: const TextStyle(color: flowlyText),
                      dropdownColor: flowlySurface,
                      decoration: const InputDecoration(labelText: 'Equipe'),
                      items: _teams
                          .map(
                            (team) => DropdownMenuItem(
                              value: team.id,
                              child: Text(
                                team.nome,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          )
                          .toList(),
                      onChanged: (value) async {
                        setState(() {
                          _selectedTeamId = value;
                          _selectedUserId = null;
                        });
                        if (value != null && value.isNotEmpty) {
                          await _loadMembers(value);
                        }
                      },
                    ),
                    SizedBox(height: sectionGap),
                    DropdownButtonFormField<String>(
                      initialValue: _selectedUserId,
                      isExpanded: true,
                      style: const TextStyle(color: flowlyText),
                      dropdownColor: flowlySurface,
                      decoration: const InputDecoration(
                        labelText: 'Usuário responsável',
                      ),
                      items: _members
                          .map(
                            (member) => DropdownMenuItem(
                              value: member.userId,
                              child: Text(
                                member.nome ?? member.email ?? member.userId,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          )
                          .toList(),
                      onChanged: (value) =>
                          setState(() => _selectedUserId = value),
                    ),
                  ],
                ),
              ),
            ),
            SizedBox(height: sectionGap + 6),
            FlowlyButton(
              onPressed: _submit,
              isLoading: _isLoading,
              label: widget.taskId == null ? 'Criar' : 'Salvar',
              color: const Color(0xFF0D9C6E),
              size: isCompact
                  ? FlowlyButtonSize.medium
                  : FlowlyButtonSize.large,
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _pickDate() async {
    final DateTime now = DateTime.now();
    final DateTime hoje = diaCivil(now);
    // Hoje ou depois; na edicao, a data atrasada ja salva continua escolhivel.
    bool permitido(DateTime dia) =>
        dataEntregaPermitida(dia, hoje: hoje, original: _dataEntregaOriginal);
    final DateTime? atual = DateTime.tryParse(_dateController.text);
    final DateTime? picked = await showDatePicker(
      context: context,
      initialDate: atual != null && permitido(atual) ? atual : hoje,
      firstDate: primeiroDiaDeEntrega(hoje: hoje, original: _dataEntregaOriginal),
      lastDate: DateTime(now.year + 5),
      selectableDayPredicate: permitido,
    );

    if (picked == null) {
      return;
    }

    _dateController.text =
        '${picked.year.toString().padLeft(4, '0')}-${picked.month.toString().padLeft(2, '0')}-${picked.day.toString().padLeft(2, '0')}';
  }

  String? _resolveId(dynamic value) {
    if (value is Map<String, dynamic>) {
      return (value['_id'] ?? value['id'] ?? '').toString();
    }
    final String resolved = (value ?? '').toString();
    return resolved.isEmpty ? null : resolved;
  }
}
