/** 1000 culturally diverse given names used for human-friendly subagent identities. */
export const AGENT_NAMES = [
  // Common masculine names
  "James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph", "Thomas", "Christopher",
  "Charles", "Daniel", "Matthew", "Anthony", "Mark", "Donald", "Steven", "Andrew", "Paul", "Joshua",
  "Kenneth", "Kevin", "Brian", "George", "Timothy", "Ronald", "Edward", "Jason", "Jeffrey", "Ryan",
  "Jacob", "Gary", "Nicholas", "Eric", "Jonathan", "Stephen", "Larry", "Justin", "Scott", "Brandon",
  "Benjamin", "Samuel", "Gregory", "Alexander", "Patrick", "Frank", "Raymond", "Jack", "Dennis", "Jerry",
  "Tyler", "Aaron", "Jose", "Adam", "Nathan", "Henry", "Douglas", "Zachary", "Peter", "Kyle",
  "Walter", "Ethan", "Jeremy", "Harold", "Keith", "Christian", "Roger", "Noah", "Gerald", "Carl",
  "Terry", "Sean", "Austin", "Arthur", "Lawrence", "Jesse", "Dylan", "Bryan", "Joe", "Jordan",
  "Billy", "Bruce", "Albert", "Willie", "Gabriel", "Logan", "Alan", "Juan", "Wayne", "Roy",
  "Ralph", "Randy", "Eugene", "Vincent", "Russell", "Elijah", "Louis", "Bobby", "Philip", "Johnny",
  "Howard", "Isaac", "Harry", "Victor", "Martin", "Ernest", "Phillip", "Todd", "Craig", "Shawn",
  "Clarence", "Carlos", "Caleb", "Blake", "Mason", "Luke", "Liam", "Owen", "Nathaniel", "Cameron",
  "Hunter", "Connor", "Adrian", "Julian", "Jeremiah", "Angel", "Isaiah", "Evan", "Colton", "Gavin",
  "Dominic", "Cooper", "Ian", "Carson", "Jaxon", "Theodore", "Hudson", "Lincoln", "Asher", "Wyatt",
  "Leo", "Ezra", "Miles", "Micah", "Silas", "Roman", "Wesley", "Brooks", "Bennett", "Parker",
  "Beau", "Weston", "Damian", "Sawyer", "Emmett", "Harrison", "Cole", "Maxwell", "Holden", "Antonio",
  "Miguel", "Oscar", "Diego", "Alejandro", "Marco", "Luis", "Javier", "Sergio", "Ricardo", "Manuel",
  "Roberto", "Francisco", "Eduardo", "Fernando", "Ruben", "Raul", "Andres", "Hector", "Edgar", "Mario",
  "Derek", "Trevor", "Travis", "Cody", "Dustin", "Corey", "Brett", "Chad", "Bradley", "Spencer",
  "Grant", "Joel", "Dean", "Dale", "Glenn", "Stanley", "Leonard", "Francis", "Herbert", "Frederick",
  "Norman", "Melvin", "Marvin", "Gordon", "Allen", "Bernard", "Clifford", "Warren", "Curtis", "Darren",
  "Troy", "Marcus", "Derrick", "Andre", "Terrence", "Maurice", "Darius", "Malcolm", "Xavier", "Preston",
  "Grayson", "Easton", "Nolan", "Everett", "Axel", "Emmanuel", "Kingston", "Elliot", "Tim", "Simon",
  "Riley", "Finn", "Jasper", "Milo", "Rowan", "Declan", "Graham", "Max", "Nash", "Reid",
  "Lane", "Tucker", "Carter", "Chase", "Coleman", "Bryce", "Hayden", "Aidan", "Jonah", "Jonas",

  // Common feminine names
  "Mary", "Patricia", "Jennifer", "Linda", "Elizabeth", "Barbara", "Susan", "Jessica", "Sarah", "Karen",
  "Lisa", "Nancy", "Betty", "Margaret", "Sandra", "Ashley", "Kimberly", "Emily", "Donna", "Michelle",
  "Carol", "Amanda", "Melissa", "Deborah", "Stephanie", "Dorothy", "Rebecca", "Sharon", "Laura", "Cynthia",
  "Amy", "Kathleen", "Angela", "Shirley", "Brenda", "Emma", "Anna", "Pamela", "Nicole", "Samantha",
  "Katherine", "Christine", "Debra", "Rachel", "Carolyn", "Janet", "Maria", "Heather", "Diane", "Julie",
  "Joyce", "Victoria", "Kelly", "Christina", "Lauren", "Joan", "Evelyn", "Olivia", "Judith", "Megan",
  "Cheryl", "Martha", "Andrea", "Frances", "Hannah", "Jacqueline", "Ann", "Gloria", "Jean", "Kathryn",
  "Alice", "Teresa", "Sara", "Janice", "Doris", "Madison", "Julia", "Grace", "Judy", "Abigail",
  "Marie", "Denise", "Beverly", "Amber", "Theresa", "Marilyn", "Danielle", "Diana", "Brittany", "Natalie",
  "Sophia", "Rose", "Isabella", "Alexis", "Kayla", "Charlotte", "Lori", "Alexandra", "Savannah", "Brooklyn",
  "Bella", "Claire", "Skylar", "Lucy", "Paisley", "Everly", "Caroline", "Nova", "Genesis", "Emilia",
  "Kennedy", "Maya", "Willow", "Kinsley", "Naomi", "Aaliyah", "Elena", "Mckenna", "Ariana", "Allison",
  "Gabriella", "Margot", "Madelyn", "Cora", "Ruby", "Eva", "Serenity", "Autumn", "Adeline", "Hailey",
  "Gianna", "Valentina", "Isla", "Eliana", "Quinn", "Nevaeh", "Ivy", "Sadie", "Piper", "Lydia",
  "Alexa", "Josephine", "Emery", "Phoebe", "Delilah", "Arianna", "Vivian", "Kaylee", "Sophie", "Brielle",
  "Madeline", "Peyton", "Rylee", "Clara", "Hadley", "Melanie", "Mackenzie", "Reagan", "Adalynn", "Liliana",
  "Aubree", "Jade", "Miranda", "Isabelle", "Natalia", "Raelynn", "Dakota", "Athena", "Ximena", "Arya",
  "Leilani", "Taylor", "Faith", "Lena", "Kylie", "Miriam", "Kate", "Summer", "Lyla", "Brooke",
  "Amaya", "Eliza", "Brianna", "Bailey", "Nina", "Khloe", "Jasmine", "Melody", "Isabel", "Norah",
  "Annabelle", "Valeria", "Emerson", "Cecilia", "Valerie", "Molly", "Reese", "Aliyah", "Lilly", "Blair",
  "Finley", "Morgan", "Sydney", "Jordyn", "Eloise", "Trinity", "Daisy", "Catherine", "Lola", "Genevieve",
  "Marley", "Arabella", "Harmony", "Elise", "Remi", "Teagan", "Evie", "London", "Sloane", "Laila",
  "Lucia", "Willa", "Juliana", "Gracie", "June", "Tessa", "Ada", "Camille", "Hope", "Samara",
  "Rosalie", "Ruth", "Fiona", "Georgia", "Noelle", "Vanessa", "Daniela", "Paige", "Violet", "Presley",
  "Adriana", "Joanna", "Giselle", "Harper", "Avery", "Scarlett", "Aria", "Ellie", "Chloe", "Layla",

  // Ancient Greek, Roman, and Mediterranean names
  "Achilles", "Aeschylus", "Agamemnon", "Alcibiades", "Andromache", "Antigone", "Apollonia", "Archimedes", "Aristides", "Aspasia",
  "Berenice", "Briseis", "Calliope", "Cassander", "Cassia", "Cato", "Cicero", "Cleisthenes", "Clio", "Cornelia",
  "Cyprian", "Damaris", "Demetrius", "Diogenes", "Electra", "Epictetus", "Eudora", "Euripides", "Galen", "Hecuba",
  "Herodotus", "Hippolyta", "Horatia", "Hypatia", "Ianthe", "Isocrates", "Laodamia", "Leander", "Livia", "Lysander",
  "Octavia", "Octavian", "Orestes", "Pericles", "Petronilla", "Plutarch", "Priam", "Sappho", "Seneca", "Themistocles",

  // Norse, Celtic, and early Germanic names
  "Aethelred", "Alaric", "Alfhild", "Ansgar", "Arnfinn", "Audhild", "Beowulf", "Boudica", "Branwen", "Brennus",
  "Brynhild", "Cadwaladr", "Caradoc", "Cerdic", "Cormac", "Cunegunda", "Dagmar", "Eadric", "Eir", "Eirik",
  "Embla", "Faramund", "Fergus", "Freydis", "Gudrun", "Gunnar", "Guthrum", "Gwendolen", "Halfdan", "Hildegard",
  "Hrolf", "Iseult", "Ivar", "Leif", "Maeve", "Niamh", "Olwen", "Orlaith", "Ragnhild", "Ragnar",
  "Rhiannon", "Sigfrid", "Sigrid", "Sigrun", "Somerled", "Svanhild", "Taliesin", "Theodelinda", "Torsten", "Yseult",

  // Medieval, Byzantine, Slavic, and Baltic names
  "Aldona", "Basilissa", "Boleslav", "Borivoj", "Bozena", "Bronislava", "Casimir", "Cyrilla", "Dobrawa", "Dragomir",
  "Drazan", "Eudokia", "Euphemia", "Fevronia", "Gavrila", "Gleb", "Jaromir", "Jelena", "Kaloyan", "Kresimir",
  "Ladislav", "Ljubica", "Ludmila", "Mieszko", "Milica", "Milos", "Miroslav", "Mstislav", "Nadezhda", "Niketas",
  "Perun", "Pribislav", "Radoslav", "Rostislav", "Simeon", "Slavomir", "Sviatoslav", "Theodora", "Tomislav", "Vaclava",
  "Vasilisa", "Vesna", "Viesturs", "Vladimir", "Vseslav", "Vytautas", "Yaroslav", "Zbigniew", "Zdislava", "Zvonimir",

  // Ancient Egyptian, Mesopotamian, Persian, Armenian, and Georgian names
  "Ahmose", "Amasis", "Amenemhat", "Ankhesenamun", "Ardashir", "Arsinoe", "Artabanus", "Artaxerxes", "Ashurbanipal", "Atossa",
  "Bardiya", "Cambyses", "Cyrus", "Enheduanna", "Esarhaddon", "Gilgamesh", "Hatshepsut", "Horemheb", "Imhotep", "Ishtar",
  "Kassandane", "Khafre", "Khufu", "Mandane", "Marduk", "Meritamen", "Mithridates", "Nabonidus", "Naram-Sin", "Nebuchadnezzar",
  "Nefertari", "Nefertiti", "Neithhotep", "Nitocris", "Parmys", "Parysatis", "Pharnaces", "Psamtik", "Roxana", "Sargon",
  "Semiramis", "Shapur", "Sinsharishkun", "Tahmasp", "Tamar", "Tigran", "Tiridates", "Tomyris", "Xerxes", "Zenobia",

  // South Asian historical, literary, and traditional names
  "Abhimanyu", "Agastya", "Amrapali", "Anasuya", "Arjuna", "Ashoka", "Bharata", "Bhaskara", "Bimbisara", "Chanakya",
  "Chandragupta", "Charulata", "Damayanti", "Dhanvantari", "Draupadi", "Gargi", "Harsha", "Hemachandra", "Ila", "Indrajit",
  "Jambavati", "Janaka", "Kalidasa", "Kanishka", "Karna", "Kausalya", "Krishna", "Lalitaditya", "Lopamudra", "Maitreyi",
  "Mandodari", "Mirabai", "Nachiketa", "Narasimha", "Padmini", "Panini", "Parvati", "Prithviraj", "Razia", "Samudragupta",
  "Savitri", "Shakuntala", "Shivaji", "Sita", "Subhadra", "Tansen", "Udayana", "Vashti", "Vikramaditya", "Vishnu",

  // East Asian historical and legendary names
  "Akiko", "Amaterasu", "Benkei", "Chiyome", "Okinagatarashi", "Himiko", "Tokimune", "Izumi", "Kaguya", "Kanetsugu",
  "Kiyomori", "Masako", "Masamune", "Murasaki", "Nobunaga", "Raikou", "Sei", "Shingen", "Tadakatsu", "Tomoe",
  "Hideyoshi", "Yamato", "Yoritomo", "Yoshitsune", "Yukimura", "Baochai", "Zhao", "Cao", "Chang'e", "Diaochan",
  "Fuxi", "Guanyu", "Zhu", "Mulan", "Bai", "Bei", "Nuwa", "Zheng", "Ping", "Quan",
  "Shimin", "Qiang", "Meiniang", "Ji", "Xishi", "Xuanzang", "Sun-sin", "Gwan-sun", "He", "Liang",

  // Southeast Asian, Central Asian, and steppe names
  "Airlangga", "Anawrahta", "Bayinnaung", "Borommatrailokkanat", "Champa", "Chulalongkorn", "Diponegoro", "Mada", "Tuah", "Rajasanagara",
  "Jayavarman", "Kartini", "Arok", "Kertanegara", "Lakshmana", "Mahendravarman", "Parameswara", "Mulavarman", "Srikandi", "Suryavarman",
  "Tribhuwana", "TrưngTrắc", "TrưngNhị", "Udayadityavarman", "Visay", "Arslan", "Babur", "Batu", "Bumin", "Chagatai",
  "Genghis", "Hulagu", "Jebe", "Kublai", "Manas", "Möngke", "Nader", "Ogedei", "Roxelana", "Seljuk",
  "Subutai", "Tokhtamysh", "Temujin", "Timur", "Tomris", "Tughril", "Taraghay", "Yesugei", "Zahiruddin", "Zebunissa",

  // African historical, royal, and traditional names
  "Amina", "Amanirenas", "Amanishakheto", "Askia", "Behanzin", "Bilqis", "Candace", "Cetshwayo", "Chaka", "Dihya",
  "Efunroye", "Ezana", "Gudit", "Hannibal", "Hanno", "Amanitore", "Idia", "Orompoto", "Jaja", "Taharqa",
  "Shanakhdakheto", "Kassa", "Khama", "Lalibela", "LatDior", "Liholiho", "Lukeni", "Makeda", "Sakura", "Mantatisi",
  "Menen", "Menelik", "Mkabayi", "Moremi", "Moshoeshoe", "Mpande", "Mzilikazi", "Nandi", "YaaAsantewaa", "Njoya",
  "Njinga", "Ewuare", "Osei", "Piankhi", "Prempeh", "Ranavalona", "Sarraounia", "Sekhukhune", "Shaka", "Sundiata",

  // Indigenous American and Pacific historical and traditional names
  "Ahuizotl", "Anacaona", "Atahualpa", "Caupolicán", "Cuitlahuac", "Cuauhtemoc", "Guarocuya", "Huascar", "Itzcoatl", "Lautaro",
  "Malinalli", "Manco", "Moctezuma", "Nezahualcoyotl", "Ollantay", "Pachacuti", "Quispe", "Rumiñahui", "Sayri", "Sinchi",
  "Tecuichpo", "Tlahuicole", "Tupac", "Xicotencatl", "Yma", "Hine-nui-te-pō", "Hongi", "Kamehameha", "Kaʻahumanu", "Keōpūolani",
  "Kupe", "Liliʻuokalani", "Makea", "Maui", "Olomu", "Ngarimu", "Pakalitha", "Pele", "Pōmare", "Ruatara",
  "Salamasina", "Tāwhiao", "Te Puea", "Tupaia", "Tūtānekai", "Uenuku", "Vaiola", "Whina", "Wherowhero", "Yosihiko",

  // Middle Eastern, North African, Iberian, and Jewish historical names
  "AbdAl-Rahman", "Aisha", "Hasan", "Ja'far", "Pelayo", "Walid", "Husayn", "Badr", "Bintou", "Abdallah",
  "Bohemond", "Rodrigo", "Fadila", "Fatima", "Qasim", "Ghazala", "Hafsa", "Harun", "Hasdrubal", "Muhammad",
  "Idris", "Ishaq", "Jahanara", "Khadija", "Khayzuran", "Leovigild", "Lubna", "Moshe", "Marwan", "Maslama",
  "Musa", "Nasir", "Rabi'a", "Rashid", "Saadia", "Salahuddin", "Shajar", "Shirin", "Suhaila", "Tariq",
  "Theodoric", "Urraca", "Wallada", "Yehuda", "Yusuf", "Zaynab", "Ziryab", "Zipporah", "Zubaida", "Zuleika",
] as const;
