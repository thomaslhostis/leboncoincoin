# Page Monitor – Extension Chrome

Reçois une notification dès qu'une nouvelle annonce apparaît sur n'importe quelle page (leboncoin, SeLoger, PAP, etc.).

## Installation

1. Génère les icônes (une seule fois) :
   ```bash
   python3 generate-icons.py
   ```
2. Dans Chrome, ouvre `chrome://extensions`
3. Active le **mode développeur** (en haut à droite)
4. Clique sur **Charger l'extension non empaquetée** et sélectionne ce dossier

## Utilisation

- Clique sur l'icône 🔔 dans la barre Chrome
- Renseigne un **nom**, une **URL** et une **fréquence** de vérification
- Le bouton 📋 pré-remplit l'URL depuis l'onglet actif
- Les nouvelles annonces déclenchent une notification cliquable qui ouvre la page

## Stratégies de détection (automatiques)

| Priorité | Stratégie | Sites concernés |
|----------|-----------|-----------------|
| 1 | `__NEXT_DATA__` (Next.js) | leboncoin, SeLoger, PAP… |
| 2 | JSON-LD structured data | Sites e-commerce |
| 3 | IDs numériques dans les URLs | La plupart des sites d'annonces |
| 4 | Attributs `data-id` / `data-listing-id` | Sites modernes |
| 5 | Hash du contenu principal | Fallback universel |

> ⚠️ La fréquence minimale est **1 minute** (limite imposée par Chrome).  
> Certains sites peuvent détecter les requêtes automatiques et retourner une page vide ou un CAPTCHA.

## Captcha & indicateur d'état

- Quand leboncoin est **injoignable pour n'importe quelle raison** (captcha, réseau,
  erreur serveur), un **triangle d'avertissement** se superpose à l'icône de l'extension.
- Une **notification** n'est envoyée que pour un **captcha** à résoudre (une seule,
  globale pour toutes les surveillances). Les erreurs réseau restent silencieuses.
- L'avertissement disparaît dès que leboncoin redevient accessible (vérification
  réussie, ou détection d'un onglet leboncoin valide).

## Tests

Tests automatisés via le runner intégré de Node (aucune dépendance) :

```bash
node --test        # ou : npm test
```

Ils couvrent l'escalade `fetch → iframe → rendu`, la détection de captcha sans
onglet, la garde réseau, la notification unique, le son limité aux nouvelles
annonces, et la logique de l'icône d'avertissement.

## Structure

```
chrome-extension/
├── manifest.json       # Manifest V3
├── background.js       # Service worker : alarmes, fetch, notifications
├── popup.html/js/css   # Interface utilisateur
├── generate-icons.py   # Générateur d'icônes (stdlib Python uniquement)
└── icons/              # Icônes générées (16, 32, 48, 128 px)
```
