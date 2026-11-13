import 'package:flutter_test/flutter_test.dart';
import 'package:meu_app/src/utils/data_entrega.dart';

// D31: data de entrega e data civil; hoje ou depois, e na edicao a data ja salva continua valida.
void main() {
  // 22:30 local: a hora nao pode empurrar "hoje" para outro dia.
  final DateTime agora = DateTime(2026, 11, 9, 22, 30);

  group('criacao', () {
    test('ontem e rejeitado', () {
      expect(dataEntregaPermitida(DateTime(2026, 11, 8), hoje: agora), isFalse);
    });

    test('hoje e aceito, inclusive vindo do texto YYYY-MM-DD', () {
      expect(dataEntregaPermitida(DateTime(2026, 11, 9), hoje: agora), isTrue);
      expect(dataEntregaPermitida(DateTime.parse('2026-11-09'), hoje: agora), isTrue);
    });

    test('amanha e aceito', () {
      expect(dataEntregaPermitida(DateTime(2026, 11, 10), hoje: agora), isTrue);
    });
  });

  group('edicao de tarefa atrasada (original 01/11)', () {
    final DateTime original = DateTime(2026, 11, 1);

    test('manter a data original e aceito', () {
      expect(dataEntregaPermitida(DateTime(2026, 11, 1), hoje: agora, original: original), isTrue);
    });

    test('outra data passada continua rejeitada', () {
      expect(dataEntregaPermitida(DateTime(2026, 11, 5), hoje: agora, original: original), isFalse);
    });

    test('hoje e futuro sao aceitos', () {
      expect(dataEntregaPermitida(DateTime(2026, 11, 9), hoje: agora, original: original), isTrue);
      expect(dataEntregaPermitida(DateTime(2026, 12, 15), hoje: agora, original: original), isTrue);
    });
  });

  group('primeiro dia do calendario', () {
    test('criacao comeca hoje, sem hora', () {
      expect(primeiroDiaDeEntrega(hoje: agora), DateTime(2026, 11, 9));
    });

    test('edicao de atrasada comeca na data original, para o picker abrir nela', () {
      expect(primeiroDiaDeEntrega(hoje: agora, original: DateTime(2026, 11, 1)), DateTime(2026, 11, 1));
    });

    test('edicao de tarefa futura comeca hoje', () {
      expect(primeiroDiaDeEntrega(hoje: agora, original: DateTime(2026, 12, 15)), DateTime(2026, 11, 9));
    });
  });
}
