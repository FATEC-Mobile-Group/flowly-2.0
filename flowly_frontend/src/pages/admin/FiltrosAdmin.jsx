import React from "react";

// Campos de pesquisa e filtro das paginas administrativas: rotulo visivel ligado ao campo, foco pelo teclado.

export function CampoBusca({ id, rotulo = "Pesquisar", valor, onChange, placeholder, disabled = false }) {
  return (
    <div className="admin-campo admin-campo-busca">
      <label htmlFor={id}>{rotulo}</label>
      <input
        id={id}
        type="search"
        value={valor}
        placeholder={placeholder}
        autoComplete="off"
        maxLength={200}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function CampoSelect({ id, rotulo, valor, opcoes, onChange, disabled = false, children }) {
  return (
    <div className="admin-campo">
      <label htmlFor={id}>{rotulo}</label>
      <select id={id} value={valor} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {(opcoes || []).map((opcao) => (
          <option key={opcao.valor} value={opcao.valor}>{opcao.rotulo}</option>
        ))}
        {children}
      </select>
    </div>
  );
}

export const plural = (quantidade, singular, pluralTexto) => `${quantidade} ${quantidade === 1 ? singular : pluralTexto}`;
