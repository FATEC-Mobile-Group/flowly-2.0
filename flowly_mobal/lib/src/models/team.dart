class Team {
  final String id;
  final String nome;
  final String descricao;
  final String? vinculoEmpresarial;
  final String code;
  final List<TeamMember> membros;

  const Team({
    required this.id,
    required this.nome,
    required this.descricao,
    this.vinculoEmpresarial,
    required this.code,
    this.membros = const [],
  });

  factory Team.fromJson(Map<String, dynamic> json) {
    final membrosData = json['membros'] as List? ?? [];
    final String generatedCode = (json['code'] ?? '').toString();
    return Team(
      id: (json['_id'] ?? json['id'] ?? '').toString(),
      nome: (json['nome'] ?? '').toString(),
      descricao: (json['descricao'] ?? '').toString(),
      vinculoEmpresarial: json['vinculoEmpresarial'] as String?,
      code: generatedCode,
      membros: membrosData
          .map((m) => TeamMember.fromJson(m as Map<String, dynamic>))
          .toList(),
    );
  }

  Map<String, dynamic> toJson() => {
    '_id': id,
    'nome': nome,
    'descricao': descricao,
    'vinculoEmpresarial': vinculoEmpresarial,
    'code': code,
    'membros': membros.map((m) => m.toJson()).toList(),
  };
}

class TeamMember {
  final String userId;
  final String role;
  final String? nome;
  final String? email;
  final String? tipo;

  const TeamMember({
    required this.userId,
    required this.role,
    this.nome,
    this.email,
    this.tipo,
  });

  factory TeamMember.fromJson(Map<String, dynamic> json) {
    final dynamic userData = json['user'];
    final String resolvedUserId = userData is Map<String, dynamic>
        ? (userData['_id'] ?? '').toString()
        : (json['user'] ?? json['userId'] ?? json['_id'] ?? '').toString();

    return TeamMember(
      userId: resolvedUserId,
      role: (json['role'] ?? 'membro').toString(),
      nome: (json['nome'] ?? (userData is Map<String, dynamic> ? userData['nome'] : null)) as String?,
      email: (json['email'] ?? (userData is Map<String, dynamic> ? userData['email'] : null)) as String?,
      tipo: (json['tipo'] ?? (userData is Map<String, dynamic> ? userData['tipo'] : null)) as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    'user': userId,
    'role': role,
    'nome': nome,
    'email': email,
    'tipo': tipo,
  };
}

/// A API so aceita conta tipo 'user' como responsavel de tarefa; membro sem tipo (API antiga) continua.
List<TeamMember> responsaveisElegiveis(Iterable<TeamMember> membros) =>
    membros.where((TeamMember membro) => membro.tipo != 'admin').toList();
