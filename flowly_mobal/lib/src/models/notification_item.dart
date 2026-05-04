class NotificationItem {
  const NotificationItem({
    required this.id,
    required this.text,
    required this.read,
    required this.type,
    required this.createdAt,
    this.originId,
    this.metadata = const <String, dynamic>{},
  });

  final String id;
  final String text;
  final bool read;
  final String type;
  final DateTime createdAt;
  final String? originId;
  final Map<String, dynamic> metadata;

  factory NotificationItem.fromJson(Map<String, dynamic> json) {
    return NotificationItem(
      id: (json['_id'] ?? '').toString(),
      text: (json['texto'] ?? '').toString(),
      read: json['lida'] == true,
      type: (json['tipo'] ?? 'system').toString(),
      createdAt: DateTime.tryParse((json['createdAt'] ?? '').toString()) ?? DateTime.now(),
      originId: json['origemId']?.toString(),
      metadata: json['metadata'] is Map<String, dynamic>
          ? json['metadata'] as Map<String, dynamic>
          : <String, dynamic>{},
    );
  }
}