require('dotenv').config();

const { ApolloServer, gql, UserInputError } = require('apollo-server');
const { PubSub } = require('graphql-subscriptions');

const jwt = require('jsonwebtoken');

const mongoose = require('mongoose');
const Book = require('./models/book');
const Author = require('./models/author');
const User = require('./models/user');

mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false,
    useCreateIndex: true,
  })
  .then(() => {
    console.log('connected to the MongoDB');
  })
  .catch((error) => {
    console.log('error connecting to MongoDB:', error.message);
  });

const pubsub = new PubSub();

const typeDefs = gql`
  type Book {
    id: ID!
    title: String!
    published: Int!
    author: Author!
    genres: [String!]!
  }
  type Author {
    id: ID!
    name: String!
    born: Int
    bookCount: Int!
  }
  type User {
    username: String!
    favoriteGenre: String!
    id: ID!
  }

  type Token {
    value: String!
  }
  type Query {
    bookCount: Int!
    authorCount: Int!
    allBooks(author: String, genre: String): [Book!]!
    allAuthors: [Author!]!
    me: User
  }
  type Mutation {
    addBook(
      title: String!
      author: String!
      published: Int!
      genres: [String!]!
    ): Book
    editAuthor(name: String!, setBornTo: Int!): Author
    createUser(username: String!, favoriteGenre: String!): User
    login(username: String!, password: String!): Token
  }
  type Subscription {
    bookAdded: Book!
  }
`;

const resolvers = {
  Query: {
    bookCount: () => Book.collection.countDocuments(),
    authorCount: () => Author.collection.countDocuments(),
    allBooks: async (root, args) => {
      if (args.author && args.genre) {
        const books = await Book.find({});
        const author = await Author.findOne({ name: args.author });

        const booksByAuthor = books.filter(
          (book) => book.author.toString() === author._id.toString()
        );
        const resultBooks = booksByAuthor.filter((book) =>
          book.genres.includes(args.genre)
        );
        return resultBooks;
      }

      if (args.author) {
        const books = await Book.find({});
        const author = await Author.findOne({ name: args.author });
        return books.filter(
          (book) => book.author.toString() === author._id.toString()
        );
      }

      if (args.genre) {
        const books = await Book.find({});
        return books.filter((book) => book.genres.includes(args.genre));
      }

      return Book.find({});
    },
    allAuthors: () => Author.find({}),
    me: (root, args, context) => {
      return context.currentUser;
    },
  },
  Author: {
    name: async (root) => {
      const author = await Author.findById(root);
      return author.name;
    },
    id: async (root) => {
      const author = await Author.findById(root);
      return author._id;
    },
    born: async (root) => {
      const author = await Author.findById(root);
      return author.born;
    },
    bookCount: async (root) => {
      const ownedBooks = await Book.find({ author: root });
      return ownedBooks.length;
    },
  },
  Mutation: {
    addBook: async (root, args, context) => {
      // check the author whether existed in the current database.
      const checkAuthorExisted = await Author.findOne({ name: args.author });

      const currentUser = context.currentUser;
      if (!currentUser) {
        throw new AuthenticationError('not authenticated');
      }

      try {
        // add author if it is not existed in the current database
        if (!checkAuthorExisted) {
          const newAuthor = new Author({ name: args.author, born: null });
          await newAuthor.save();

          const newBook = new Book({ ...args, author: newAuthor._id });

          pubsub.publish('BOOK_ADDED', { bookAdded: newBook });
          return newBook.save();
        }

        const newBook = new Book({ ...args, author: checkAuthorExisted._id });

        pubsub.publish('BOOK_ADDED', { bookAdded: newBook });

        return newBook.save();
      } catch (error) {
        throw new UserInputError('Invalid argument value', error.message);
      }
    },
    editAuthor: async (root, args, context) => {
      // check the target author whether existed in the current database.
      const targetAuthor = await Author.findOne({ name: args.name });
      targetAuthor.born = args.setBornTo;

      const currentUser = context.currentUser;
      if (!currentUser) {
        throw new AuthenticationError('not authenticated');
      }

      try {
        targetAuthor.save();
      } catch (error) {
        throw new UserInputError('Invalid argument value', error.message);
      }

      return targetAuthor;
    },
    createUser: async (root, args) => {
      const user = new User({
        username: args.username,
        favoriteGenre: args.favoriteGenre,
      });

      try {
        user.save();
      } catch (error) {
        throw new UserInputError('Invalid argument value', error.message);
      }

      return user;
    },
    login: async (root, args) => {
      const user = await User.findOne({ username: args.username });

      if (!user || args.password !== 'secret') {
        throw new UserInputError('wrong credentials');
      }

      const userForToken = {
        username: user.username,
        id: user._id,
      };

      return { value: jwt.sign(userForToken, process.env.JWT_SECRET) };
    },
  },
  Subscription: {
    bookAdded: {
      subscribe: () => pubsub.asyncIterator(['BOOK_ADDED']),
    },
  },
};

const server = new ApolloServer({
  typeDefs,
  resolvers,
  context: async ({ req }) => {
    const auth = req ? req.headers.authorization : null;

    if (auth && auth.toLowerCase().startsWith('bearer ')) {
      const decodedToken = jwt.verify(
        auth.substring(7),
        process.env.JWT_SECRET
      );
      const currentUser = await User.findById(decodedToken.id);
      return { currentUser };
    }
  },
});

server.listen().then(({ url, subscriptionsUrl }) => {
  console.log(`Server ready at ${url}`);
  console.log(`Subscriptions ready at ${subscriptionsUrl}`);
});
