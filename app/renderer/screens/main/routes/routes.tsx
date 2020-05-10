import React, { Component } from 'react';
import { Route, RouteComponentProps } from 'react-router-dom';
import { Layout } from 'antd';
import { HomeOutlined, UserOutlined, PieChartOutlined, InboxOutlined, TrophyOutlined } from '@ant-design/icons';
import { RouteConfig } from 'renderer/screens/main/types';
import Sidebar from 'renderer/screens/main/components/sidebar';
import Home from './home';
import Inbox from './inbox';


const routes: RouteConfig[] = [
  { key: '/', path: '/', component: Home, title: 'Home', icon: HomeOutlined },
  { key: '/inbox', path: '/inbox/:id?', component: Inbox, title: 'Inbox', icon: InboxOutlined },
  { key: '/squad', path: '/squad', component: Home, title: 'Squad', icon: UserOutlined },
  {
    key: '/transfers', path: '/transfers', component: Home, title: 'Transfers', icon: PieChartOutlined,
    subroutes: [
      { key: '/transfers/buy', path: '/transfers/buy', component: Home, title: 'Buy Players' },
      { key: '/transfers/search', path: '/transfers/search', component: Home, title: 'Search Players' },
    ]
  },
  { key: '/competitions', path: '/competitions', component: Home, title: 'Competitions', icon: TrophyOutlined },
];


/**
 * The routes component.
 */

interface State {
  collapsed: boolean;
}


class Routes extends Component<RouteComponentProps, State> {
  public state = {
    collapsed: false,
  }

  private logourl = 'https://upload.wikimedia.org/wikipedia/en/1/13/Real_betis_logo.svg';

  private handleOnCollapse = ( collapsed: boolean ) => {
    this.setState({ collapsed });
  }

  public render() {
    return (
      <Layout id="main">
        {/* RENDER THE SIDEBAR */}
        {routes.map( r => (
          <Route
            exact
            key={r.path}
            path={r.path}
            render={props => (
              <Sidebar
                {...props}
                config={routes}
                logourl={this.logourl}
                collapsed={this.state.collapsed}
                onCollapse={this.handleOnCollapse}
              />
            )}
          />
        ))}

        {/* RENDER THE MAIN CONTENT */}
        <Layout.Content>
          {routes.map( r => (
            <Route
              exact
              key={r.path}
              path={r.path}
              component={r.component}
            />
          ))}
        </Layout.Content>
      </Layout>
    );
  }
}


export default Routes;