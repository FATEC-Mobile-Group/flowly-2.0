import React from 'react';
import '../../styles/components/ColorBendsBackground.css';

const ColorBendsBackground = () => {
  return (
    <div className="color-bends-container">
      {/* Recorte do tamanho da tela (+ margem do desfoque): o desfoque refeito a cada quadro cobre so a area visivel,
          nao o campo inteiro, que e bem maior que a tela. */}
      <div className="xmb-field-clip" aria-hidden="true">
        <div className="xmb-field">
          <div className="xmb-wave xmb-wave-1"></div>
          <div className="xmb-wave xmb-wave-2"></div>
          <div className="xmb-wave xmb-wave-3"></div>
          <div className="xmb-wave xmb-wave-4"></div>
          <div className="xmb-lightbeam xmb-lightbeam-1"></div>
          <div className="xmb-lightbeam xmb-lightbeam-2"></div>
          <div className="xmb-lightbeam xmb-lightbeam-3"></div>
          <div className="xmb-particles xmb-particles-1"></div>
          <div className="xmb-particles xmb-particles-2"></div>
          <div className="xmb-glow"></div>
        </div>
      </div>
      <div className="noise-overlay"></div>
    </div>
  );
};

export default ColorBendsBackground;
