/// Dia civil local, sem hora.
DateTime diaCivil(DateTime data) => DateTime(data.year, data.month, data.day);

/// Data de entrega e hoje ou depois; na edicao, a data ja salva continua aceita mesmo atrasada.
bool dataEntregaPermitida(DateTime dia, {required DateTime hoje, DateTime? original}) {
  final DateTime alvo = diaCivil(dia);
  if (original != null && alvo == diaCivil(original)) {
    return true;
  }
  return !alvo.isBefore(diaCivil(hoje));
}

/// Primeiro dia do calendario: hoje, ou a data original atrasada para o seletor poder abrir nela.
DateTime primeiroDiaDeEntrega({required DateTime hoje, DateTime? original}) {
  final DateTime inicio = diaCivil(hoje);
  if (original == null) {
    return inicio;
  }
  final DateTime dataOriginal = diaCivil(original);
  return dataOriginal.isBefore(inicio) ? dataOriginal : inicio;
}
