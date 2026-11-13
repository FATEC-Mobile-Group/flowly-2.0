import 'package:flutter_test/flutter_test.dart';
import 'package:meu_app/src/models/team.dart';

// D10: a API so aceita conta tipo 'user' como responsavel de tarefa.
void main() {
  final List<TeamMember> membros = <Map<String, dynamic>>[
    <String, dynamic>{'_id': 'u1', 'nome': 'Ana', 'tipo': 'user'},
    <String, dynamic>{'_id': 'a1', 'nome': 'Admin', 'tipo': 'admin'},
    <String, dynamic>{'_id': 'u2', 'nome': 'Bruno'},
  ].map(TeamMember.fromJson).toList();

  test('le o tipo do membro vindo de /api/equipes/:id/membros', () {
    expect(membros.map((TeamMember m) => m.tipo), <String?>['user', 'admin', null]);
  });

  test('responsaveis elegiveis nao incluem administradores', () {
    final List<String?> nomes = responsaveisElegiveis(membros).map((TeamMember m) => m.nome).toList();

    expect(nomes, contains('Ana'));
    expect(nomes, isNot(contains('Admin')));
  });

  test('membro sem tipo (API antiga) continua elegivel e a ordem e mantida', () {
    expect(
      responsaveisElegiveis(membros).map((TeamMember m) => m.userId),
      <String>['u1', 'u2'],
    );
  });

  test('equipe so com o administrador criador fica sem candidatos', () {
    expect(responsaveisElegiveis(<TeamMember>[membros[1]]), isEmpty);
  });
}
