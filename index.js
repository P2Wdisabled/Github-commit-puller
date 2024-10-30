const { Client, GatewayIntentBits, ChannelType, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const dotenv = require('dotenv');
const fs = require('fs');
const schedule = require('node-schedule');

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

const GUILD_ID = process.env.GUILD_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const POLL_INTERVAL_MINUTES = parseInt(process.env.POLL_INTERVAL_MINUTES) || 5;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const BLACKLIST_REPOSITORIES = process.env.BLACKLIST_REPOSITORIES ? process.env.BLACKLIST_REPOSITORIES.split(',') : [];

const STATE_FILE = './state.json';

// Charger l'état
let state = { repositories: {} };
if (fs.existsSync(STATE_FILE)) {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    console.log('État chargé avec succès.');
  } catch (error) {
    console.error('Erreur lors de la lecture de state.json:', error.message);
    // Initialiser un état vide si le fichier est corrompu
    state = { repositories: {} };
  }
} else {
  console.log('state.json non trouvé. Initialisation d\'un nouvel état.');
}

// Sauvegarder l'état
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log('État sauvegardé.');
  } catch (error) {
    console.error('Erreur lors de la sauvegarde de state.json:', error.message);
  }
}

// Récupérer les dépôts publics de l'utilisateur GitHub
async function fetchUserRepositories() {
  try {
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
    };
    if (GITHUB_TOKEN) {
      headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    }

    const response = await axios.get(`https://api.github.com/users/${GITHUB_USERNAME}/repos`, {
      headers,
      params: {
        type: 'public',
        per_page: 100
      }
    });

    const repos = response.data.map(repo => repo.full_name);
    // Exclure les dépôts de la blacklist
    const monitoredRepos = repos.filter(repo => !BLACKLIST_REPOSITORIES.includes(repo));

    console.log(`Dépôts surveillés (${monitoredRepos.length}) :`, monitoredRepos);
    return monitoredRepos;
  } catch (error) {
    console.error('Erreur lors de la récupération des dépôts utilisateur:', error.message);
    return [];
  }
}

// Récupérer les commits d'un dépôt spécifique
async function fetchRepoCommits(repoName) {
  try {
    console.log(`Récupération des commits pour le dépôt : ${repoName}`);
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
    };
    if (GITHUB_TOKEN) {
      headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    }

    let page = 1;
    let commits = [];
    let hasMore = true;

    while (hasMore) {
      const response = await axios.get(`https://api.github.com/repos/${repoName}/commits`, {
        headers,
        params: {
          per_page: 100,
          page: page
        }
      });

      if (response.data.length === 0) {
        hasMore = false;
      } else {
        commits = commits.concat(response.data);
        page++;
      }
    }

    console.log(`Total commits récupérés pour ${repoName}: ${commits.length}`);
    return commits;
  } catch (error) {
    console.error(`Erreur lors de la récupération des commits pour ${repoName}:`, error.message);
    return [];
  }
}

// Récupérer les releases d'un dépôt spécifique
async function fetchRepoReleases(repoName) {
  try {
    console.log(`Récupération des releases pour le dépôt : ${repoName}`);
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
    };
    if (GITHUB_TOKEN) {
      headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    }

    const response = await axios.get(`https://api.github.com/repos/${repoName}/releases`, {
      headers,
      params: {
        per_page: 100
      }
    });

    const releases = response.data;
    console.log(`Total releases récupérées pour ${repoName}: ${releases.length}`);
    return releases;
  } catch (error) {
    console.error(`Erreur lors de la récupération des releases pour ${repoName}:`, error.message);
    return [];
  }
}

// Gérer un dépôt spécifique
async function handleRepository(repoName) {
  const guild = await client.guilds.fetch(GUILD_ID);
  const repoUrl = `https://github.com/${repoName}`;

  // Définir le nom du salon basé sur le nom du dépôt avec émoji
  const channelName = `📂-${repoName.toLowerCase().replace('/', '-')}`;

  // Vérifier si le salon existe déjà ; sinon, le créer
  let channel = guild.channels.cache.find(c => c.name === channelName && c.type === ChannelType.GuildText);
  if (!channel) {
    try {
      channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `Monitoring activities for repository **${repoName}**`,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: ['ViewChannel'],
            deny: ['SendMessages'],
          },
        ],
      });
      await channel.send(`📂 Salon créé pour le dépôt **${repoName}**. [Lien vers le dépôt](${repoUrl})`);
      console.log(`Salon créé: ${channelName}`);

      // Initialiser l'état du dépôt avec la dernière date de commit et release
      const latestCommits = await fetchRepoCommits(repoName);
      const latestReleases = await fetchRepoReleases(repoName);

      const latestCommitDate = latestCommits.length > 0 ? latestCommits[0].commit.author.date : null;
      const latestReleaseDate = latestReleases.length > 0 ? latestReleases[0].created_at : null;

      if (!state.repositories[repoName]) {
        state.repositories[repoName] = {
          lastCommitDate: latestCommitDate,
          lastReleaseDate: latestReleaseDate
        };
        saveState();
        console.log(`État initialisé pour ${repoName}:`, state.repositories[repoName]);
      }

      // Optionnel : Envoyer tous les commits et releases existants lors de la création du salon
      // Commenter les lignes suivantes si vous ne souhaitez pas envoyer les historiques
      /*
      await sendAllCommits(repoName, channel);
      await sendAllReleases(repoName, channel);
      */
    } catch (error) {
      console.error(`Erreur lors de la création du salon pour ${repoName}:`, error.message);
    }
  } else {
    console.log(`Salon existant trouvé pour ${repoName}: ${channelName}`);
    // Envoyer les commits et releases manquants
    await sendNewCommits(repoName, channel);
    await sendNewReleases(repoName, channel);
  }
}

// Envoyer les nouveaux commits depuis le dernier traité
async function sendNewCommits(repoName, channel) {
  try {
    console.log(`Envoi des nouveaux commits pour ${repoName}`);
    const commits = await fetchRepoCommits(repoName);

    if (!state.repositories[repoName]) {
      state.repositories[repoName] = {
        lastCommitDate: null,
        lastReleaseDate: null
      };
    }

    // Trier les commits du plus ancien au plus récent
    const sortedCommits = commits.sort((a, b) => new Date(a.commit.author.date) - new Date(b.commit.author.date));

    let newCommits = [];
    let latestCommitDate = state.repositories[repoName].lastCommitDate;

    for (const commit of sortedCommits) {
      const commitDate = new Date(commit.commit.author.date).toISOString();

      if (state.repositories[repoName].lastCommitDate && commitDate <= state.repositories[repoName].lastCommitDate) {
        continue; // Ignorer les commits déjà traités
      }

      newCommits.push(commit);

      if (!latestCommitDate || commitDate > latestCommitDate) {
        latestCommitDate = commitDate;
      }
    }

    if (newCommits.length === 0) {
      console.log(`Aucun nouveau commit pour ${repoName}.`);
      return;
    }

    // Envoyer les commits dans l'ordre du plus ancien au plus récent
    for (const commit of newCommits) {
      const commitMessage = commit.commit.message;
      const commitUrl = commit.html_url;
      const author = commit.commit.author.name;
      const commitDate = new Date(commit.commit.author.date);

      const embed = new EmbedBuilder()
        .setColor(0x0099ff) // Couleur bleue
        .setTitle(`📝 Nouveau Commit dans ${repoName}`)
        .setURL(commitUrl)
        .setAuthor({ name: author })
        .setDescription(commitMessage)
        .setTimestamp(commitDate);

      await channel.send({ embeds: [embed] });
      console.log(`Nouveau commit dans ${repoName} par ${author}: ${commitMessage}`);
    }

    // Mettre à jour l'état avec la date du dernier commit
    state.repositories[repoName].lastCommitDate = latestCommitDate;
    saveState();
    console.log(`État mis à jour pour ${repoName} avec lastCommitDate: ${state.repositories[repoName].lastCommitDate}`);

    console.log(`Les nouveaux commits pour ${repoName} ont été envoyés.`);
  } catch (error) {
    console.error(`Erreur lors de l'envoi des nouveaux commits pour ${repoName}:`, error.message);
  }
}

// Envoyer les nouvelles releases depuis le dernier traité
async function sendNewReleases(repoName, channel) {
  try {
    console.log(`Envoi des nouvelles releases pour ${repoName}`);
    const releases = await fetchRepoReleases(repoName);

    if (!state.repositories[repoName]) {
      state.repositories[repoName] = {
        lastCommitDate: null,
        lastReleaseDate: null
      };
    }

    // Trier les releases du plus ancien au plus récent
    const sortedReleases = releases.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    let newReleases = [];
    let latestReleaseDate = state.repositories[repoName].lastReleaseDate;

    for (const release of sortedReleases) {
      const releaseDate = new Date(release.created_at).toISOString();

      if (state.repositories[repoName].lastReleaseDate && releaseDate <= state.repositories[repoName].lastReleaseDate) {
        continue; // Ignorer les releases déjà traitées
      }

      newReleases.push(release);

      if (!latestReleaseDate || releaseDate > latestReleaseDate) {
        latestReleaseDate = releaseDate;
      }
    }

    if (newReleases.length === 0) {
      console.log(`Aucune nouvelle release pour ${repoName}.`);
      return;
    }

    // Envoyer les releases dans l'ordre du plus ancien au plus récent
    for (const release of newReleases) {
      const releaseName = release.name || release.tag_name;
      const releaseBody = release.body || 'Aucune description fournie.';
      const releaseUrl = release.html_url;
      const releaseDate = new Date(release.created_at);

      const embed = new EmbedBuilder()
        .setColor(0x00ff00) // Couleur verte
        .setTitle(`🚀 Nouvelle Release dans ${repoName}`)
        .setURL(releaseUrl)
        .setDescription(releaseBody)
        .setTimestamp(releaseDate);

      if (release.assets && release.assets.length > 0) {
        embed.addFields(
          release.assets.map(asset => ({
            name: 'Téléchargement',
            value: `[${asset.name}](${asset.browser_download_url})`,
            inline: true
          }))
        );
      }

      await channel.send({ embeds: [embed] });
      console.log(`Nouvelle release dans ${repoName}: ${releaseName}`);
    }

    // Mettre à jour l'état avec la date de la dernière release
    state.repositories[repoName].lastReleaseDate = latestReleaseDate;
    saveState();
    console.log(`État mis à jour pour ${repoName} avec lastReleaseDate: ${state.repositories[repoName].lastReleaseDate}`);

    console.log(`Les nouvelles releases pour ${repoName} ont été envoyées.`);
  } catch (error) {
    console.error(`Erreur lors de l'envoi des nouvelles releases pour ${repoName}:`, error.message);
  }
}

// Initialiser tous les salons et envoyer les commits/releases manquants
async function initializeRepositories(monitoredRepos) {
  for (const repoName of monitoredRepos) {
    console.log(`Initialisation du dépôt : ${repoName}`);
    await handleRepository(repoName);
  }
}

// Détecter et gérer les nouveaux dépôts
async function detectNewRepositories(monitoredRepos) {
  try {
    const currentRepos = monitoredRepos;
    const knownRepos = Object.keys(state.repositories);

    // Détecter les nouveaux dépôts
    const newRepos = currentRepos.filter(repo => !knownRepos.includes(repo));

    if (newRepos.length > 0) {
      console.log(`Nouveaux dépôts détectés (${newRepos.length}) :`, newRepos);
      for (const repoName of newRepos) {
        await handleRepository(repoName);
      }
    } else {
      console.log('Aucun nouveau dépôt détecté.');
    }
  } catch (error) {
    console.error('Erreur lors de la détection des nouveaux dépôts:', error.message);
  }
}

// Planifier le polling
async function schedulePolling(monitoredRepos) {
  if (monitoredRepos.length === 0) {
    console.log('Aucun dépôt surveillé trouvé.');
    return;
  }

  // Initialisation : Vérifier et créer les salons, envoyer les commits et releases manquants
  await initializeRepositories(monitoredRepos);

  // Planifier les récupérations suivantes
  schedule.scheduleJob(`*/${POLL_INTERVAL_MINUTES} * * * *`, async () => {
    console.log('Début du cycle de polling.');

    // Récupérer les dépôts actuels
    const currentMonitoredRepos = await fetchUserRepositories();

    // Détecter et gérer les nouveaux dépôts
    await detectNewRepositories(currentMonitoredRepos);

    // Envoyer les nouveaux commits et releases pour tous les dépôts surveillés
    for (const repoName of currentMonitoredRepos) {
      const guild = client.guilds.cache.get(GUILD_ID);
      const channelName = `📂-${repoName.toLowerCase().replace('/', '-')}`;
      const channel = guild.channels.cache.find(c => c.name === channelName && c.type === ChannelType.GuildText);
      if (channel) {
        await sendNewCommits(repoName, channel);
        await sendNewReleases(repoName, channel);
      } else {
        console.warn(`Salon ${channelName} non trouvé pour ${repoName}.`);
      }
    }

    console.log(`Cycle de polling terminé à ${new Date().toLocaleString()}`);
  });

  console.log(`Polling des événements GitHub toutes les ${POLL_INTERVAL_MINUTES} minutes pour les dépôts surveillés.`);
}

client.once('ready', async () => {
  console.log(`Connecté en tant que ${client.user.tag}!`);
  const monitoredRepos = await fetchUserRepositories();
  await schedulePolling(monitoredRepos);
});

client.login(DISCORD_TOKEN);
